"""
Enrich dp_donors with direct GHL contact ids by searching GHL by email.
Fills in dp_donors.ghl_contact_id for the ~80% of donors who aren't
matched to a current family-graph parent (alumni, community members,
businesses). Once populated, the Donors dashboard "Open in GHL" link
jumps straight to the contact instead of showing the search-page
fallback.

Usage:
    DATABASE_URL=postgres://... python scripts/enrich-donors-ghl.py \
        --school-id <uuid> [--force] [--limit N] [--rate 5]

Defaults:
    - Skips donors that already have ghl_contact_id set (re-run is cheap).
      Use --force to re-lookup every donor with an email.
    - --rate is requests/second (GHL allows 10/s/location; we default to
      5 to be safe).

Stores ghl_contact_lookup_at + ghl_contact_lookup_result on every
attempted donor so we don't repeatedly hit GHL for donors we already
know aren't there.

Idempotent. Safe to re-run.
"""
import argparse
import os
import sys
import time
import psycopg2
import requests


def fetch_pit(cur, school_id):
    """Pulls and decrypts the school's GHL PIT via the same node helper
    that the app uses. Cleanest: shell out to a tiny one-liner. But to
    keep this script self-contained (no Node dependency), we copy the
    decryption inline using cryptography lib AES-256-GCM."""
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
        sys.exit("ENCRYPTION_KEY env var required (same as the Next app uses)")

    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        sys.exit(f"ENCRYPTION_KEY must decode to 32 bytes (got {len(key)})")

    # psycopg2 returns bytea as memoryview/bytes; ensure bytes
    ct = bytes(ct) if not isinstance(ct, bytes) else ct
    iv = bytes(iv) if not isinstance(iv, bytes) else iv
    tag = bytes(tag) if not isinstance(tag, bytes) else tag
    aes = AESGCM(key)
    pit = aes.decrypt(iv, ct + tag, None).decode("utf-8")
    return loc, pit


def search_contact_by_email(session, location_id, pit, email):
    """Single POST to GHL /contacts/search. Returns contact id or None."""
    url = "https://services.leadconnectorhq.com/contacts/search"
    body = {
        "locationId": location_id,
        "pageLimit": 5,
        "page": 1,
        "filters": [{"field": "email", "operator": "eq", "value": email.lower()}],
    }
    headers = {
        "Authorization": f"Bearer {pit}",
        "Version": "2021-07-28",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    resp = session.post(url, json=body, headers=headers, timeout=15)
    if resp.status_code >= 400:
        raise RuntimeError(f"GHL search {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    contacts = data.get("contacts") or []
    if not contacts:
        return None
    # Re-confirm in-memory in case GHL filter is case-sensitive
    needle = email.lower()
    for c in contacts:
        if (c.get("email") or "").strip().lower() == needle:
            return c.get("id")
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--force", action="store_true",
                   help="re-lookup even donors with ghl_contact_id already set")
    p.add_argument("--limit", type=int, default=0,
                   help="stop after N lookups (0 = unlimited)")
    p.add_argument("--rate", type=float, default=5.0,
                   help="max GHL requests/sec (default 5)")
    args = p.parse_args()

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL env var required")

    conn = psycopg2.connect(db)
    conn.autocommit = False
    cur = conn.cursor()

    location_id, pit = fetch_pit(cur, args.school_id)
    print(f"school location: {location_id}")

    # Candidates: donors with an email; skip ones already enriched unless --force
    where = """
        school_id = %s
        AND email_lower IS NOT NULL AND email_lower <> ''
    """
    if not args.force:
        where += " AND (ghl_contact_id IS NULL AND ghl_contact_lookup_at IS NULL)"
    cur.execute(
        f"SELECT id, dp_donor_id, email_lower FROM dp_donors WHERE {where} ORDER BY id",
        (args.school_id,),
    )
    rows = cur.fetchall()
    total = len(rows)
    if args.limit and total > args.limit:
        rows = rows[:args.limit]
    print(f"candidates to enrich: {len(rows)} (of {total} eligible)")

    if not rows:
        conn.close()
        return

    session = requests.Session()
    found = 0
    not_found = 0
    errors = 0
    min_interval = 1.0 / max(args.rate, 0.1)
    last_call = 0.0

    for i, (donor_uuid, dp_donor_id, email) in enumerate(rows):
        # Rate limit
        wait = (last_call + min_interval) - time.time()
        if wait > 0:
            time.sleep(wait)
        last_call = time.time()

        try:
            contact_id = search_contact_by_email(session, location_id, pit, email)
            if contact_id:
                cur.execute(
                    """UPDATE dp_donors
                       SET ghl_contact_id = %s,
                           ghl_contact_lookup_at = now(),
                           ghl_contact_lookup_result = 'found'
                       WHERE id = %s""",
                    (contact_id, donor_uuid),
                )
                found += 1
            else:
                cur.execute(
                    """UPDATE dp_donors
                       SET ghl_contact_lookup_at = now(),
                           ghl_contact_lookup_result = 'not_found'
                       WHERE id = %s""",
                    (donor_uuid,),
                )
                not_found += 1
        except Exception as e:
            errors += 1
            cur.execute(
                """UPDATE dp_donors
                   SET ghl_contact_lookup_at = now(),
                       ghl_contact_lookup_result = 'error'
                   WHERE id = %s""",
                (donor_uuid,),
            )
            print(f"  [err] {email}: {e}")

        # Periodic commits + progress
        if (i + 1) % 50 == 0:
            conn.commit()
            print(f"  {i+1}/{len(rows)}  found={found} not_found={not_found} errors={errors}")

    conn.commit()
    cur.close()
    conn.close()

    print()
    print("=== Done ===")
    print(f"  found:      {found}")
    print(f"  not_found:  {not_found}")
    print(f"  errors:     {errors}")


if __name__ == "__main__":
    main()
