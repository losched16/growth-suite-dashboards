"""
Push donor summary values to GHL contact custom fields.

For each donor in dp_donors that has a linked ghl_contact_id (either
from the family-graph parent match OR from the GHL-email enrichment),
write these 8 fields onto the GHL contact:
  donor_lifetime_giving   = dp_donors.gift_total
  donor_last_gift_date    = MAX(dp_gifts.gift_date)
  donor_last_gift_amount  = amount of that last gift
  donor_gifts_count       = dp_donors.gifts_count
  donor_ytd_giving        = SUM(dp_gifts.amount) for the current school year
  donor_segment           = dp_donors.inferred_segment
  donor_tags              = comma-joined donor_tags
  is_donor                = "Yes" if gifts_count > 0 else "No"

Re-runnable. School year defaults to July 1 boundary.

Usage:
    DATABASE_URL=postgres://... ENCRYPTION_KEY=... \\
      python scripts/sync-donors-to-ghl.py --school-id <uuid> [--rate 5] [--limit N]
"""
import argparse
import base64
import os
import sys
import time
import psycopg2
import requests


# Order matters only for log output. Keys must match the fields created
# by setup-donor-fields-in-ghl.py.
FIELD_KEYS = [
    "donor_lifetime_giving",
    "donor_last_gift_date",
    "donor_last_gift_amount",
    "donor_gifts_count",
    "donor_ytd_giving",
    "donor_segment",
    "donor_tags",
    "is_donor",
]


def fetch_pit(cur, school_id):
    cur.execute(
        """SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
           FROM schools WHERE id = %s""",
        (school_id,),
    )
    row = cur.fetchone()
    if not row:
        sys.exit(f"school {school_id} not found")
    loc, ct, iv, tag = row
    key_b64 = os.environ.get("ENCRYPTION_KEY")
    if not key_b64:
        sys.exit("ENCRYPTION_KEY env var required")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = base64.b64decode(key_b64)
    ct = bytes(ct); iv = bytes(iv); tag = bytes(tag)
    return loc, AESGCM(key).decrypt(iv, ct + tag, None).decode("utf-8")


def load_field_id_map(session, location_id, pit):
    """fieldKey (normalized) -> field id"""
    r = session.get(
        f"https://services.leadconnectorhq.com/locations/{location_id}/customFields",
        headers={
            "Authorization": f"Bearer {pit}",
            "Version": "2021-07-28",
            "Accept": "application/json",
        },
        timeout=15,
    )
    if r.status_code >= 400:
        sys.exit(f"listCustomFields failed: {r.status_code} {r.text[:300]}")
    out = {}
    for f in r.json().get("customFields", []):
        raw = (f.get("fieldKey") or "").replace("contact.", "")
        if raw:
            out[raw] = f["id"]
    missing = [k for k in FIELD_KEYS if k not in out]
    if missing:
        sys.exit(
            f"Missing fields in GHL: {missing}\n"
            f"Run scripts/setup-donor-fields-in-ghl.py first."
        )
    return {k: out[k] for k in FIELD_KEYS}


def school_year_start_iso(now):
    """July-1 boundary. If today is on/after July 1, start = July 1 of this year."""
    year = now.year if now.month >= 7 else now.year - 1
    return f"{year}-07-01"


def build_payload(donor, field_ids):
    """Returns list of {id, field_value} for the PUT body."""
    custom_fields = []

    def add(key, value):
        # Skip None / empty so we don't wipe existing GHL values
        # unnecessarily — though GHL accepts empty strings.
        if value is None:
            return
        custom_fields.append({"id": field_ids[key], "field_value": value})

    add("donor_lifetime_giving", _money(donor["gift_total"]))
    add("donor_last_gift_date", donor["last_gift_date_iso"])
    add("donor_last_gift_amount", _money(donor["last_gift_amount"]))
    add("donor_gifts_count", donor["gifts_count"])
    add("donor_ytd_giving", _money(donor["ytd_giving"]))
    add("donor_segment", donor["inferred_segment"] or "")
    add("donor_tags", donor["tags_csv"] or "")
    # Use "Yes" / "No" matching the picklist options we created
    add("is_donor", "Yes" if (donor["gifts_count"] or 0) > 0 else "No")
    return custom_fields


def _money(v):
    if v is None:
        return 0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0


def update_contact(session, location_id, pit, contact_id, custom_fields):
    body = {"customFields": custom_fields}
    r = session.put(
        f"https://services.leadconnectorhq.com/contacts/{contact_id}",
        json=body,
        headers={
            "Authorization": f"Bearer {pit}",
            "Version": "2021-07-28",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        timeout=20,
    )
    if r.status_code >= 400:
        return False, f"{r.status_code} {r.text[:300]}"
    return True, None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--rate", type=float, default=5.0, help="GHL req/sec (max safe is ~8)")
    p.add_argument("--limit", type=int, default=0, help="stop after N updates")
    p.add_argument("--dry-run", action="store_true", help="don't actually call GHL")
    args = p.parse_args()

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL env var required")

    conn = psycopg2.connect(db)
    cur = conn.cursor()
    location_id, pit = fetch_pit(cur, args.school_id)
    print(f"School GHL location: {location_id}")

    session = requests.Session()
    field_ids = load_field_id_map(session, location_id, pit)
    print(f"Field ids resolved: {len(field_ids)}")

    # Determine school-year start
    from datetime import datetime
    school_year_start = school_year_start_iso(datetime.utcnow())

    # Pull all matched donors with rolled-up gift aggregates + tags
    cur.execute(
        """SELECT
             d.id                                  AS dp_donor_uuid,
             d.dp_donor_id,
             COALESCE(d.ghl_contact_id, p.ghl_contact_id) AS contact_id,
             d.gift_total,
             d.gifts_count,
             d.inferred_segment,
             (SELECT MAX(g.gift_date) FROM dp_gifts g WHERE g.donor_uuid = d.id) AS last_gift_date,
             (SELECT g2.amount FROM dp_gifts g2
                WHERE g2.donor_uuid = d.id
                ORDER BY g2.gift_date DESC NULLS LAST, g2.dp_gift_id DESC
                LIMIT 1) AS last_gift_amount,
             COALESCE(
               (SELECT SUM(g3.amount) FROM dp_gifts g3
                  WHERE g3.donor_uuid = d.id AND g3.gift_date >= %s::date),
               0
             ) AS ytd_giving,
             COALESCE(
               (SELECT string_agg(t.tag, ',' ORDER BY t.tag) FROM donor_tags t
                  WHERE t.school_id = d.school_id AND t.dp_donor_id = d.dp_donor_id),
               ''
             ) AS tags_csv
           FROM dp_donors d
           LEFT JOIN parents p ON p.id = d.matched_parent_id
           WHERE d.school_id = %s
             AND (d.ghl_contact_id IS NOT NULL OR p.ghl_contact_id IS NOT NULL)
           ORDER BY d.gift_total DESC NULLS LAST""",
        (school_year_start, args.school_id),
    )
    raw = cur.fetchall()
    cur.close()
    conn.close()

    donors = []
    for row in raw:
        donors.append({
            "dp_donor_uuid": row[0],
            "dp_donor_id": row[1],
            "contact_id": row[2],
            "gift_total": row[3],
            "gifts_count": row[4],
            "inferred_segment": row[5],
            "last_gift_date_iso": row[6].isoformat() if row[6] else None,
            "last_gift_amount": row[7],
            "ytd_giving": row[8],
            "tags_csv": row[9],
        })
    if args.limit and len(donors) > args.limit:
        donors = donors[:args.limit]
    print(f"Donors to sync (matched to a GHL contact): {len(donors)}")
    if not donors:
        print("Nothing to do.")
        return

    successes = 0
    failures = 0
    min_interval = 1.0 / max(args.rate, 0.1)
    last_call = 0.0
    err_samples = []

    for i, donor in enumerate(donors):
        payload = build_payload(donor, field_ids)
        if args.dry_run:
            if i < 3:
                print(f"  [dry] {donor['contact_id']} fields={len(payload)} "
                      f"lifetime=${donor['gift_total']} gifts={donor['gifts_count']}")
            continue

        wait = (last_call + min_interval) - time.time()
        if wait > 0:
            time.sleep(wait)
        last_call = time.time()

        ok, err = update_contact(session, location_id, pit, donor["contact_id"], payload)
        if ok:
            successes += 1
        else:
            failures += 1
            if len(err_samples) < 5:
                err_samples.append(f"{donor['contact_id']}: {err}")

        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(donors)}  ok={successes} fail={failures}")

    print()
    print(f"=== Done: {successes} updated, {failures} failed ===")
    for s in err_samples:
        print(f"  err: {s}")


if __name__ == "__main__":
    main()
