"""
Bulk-import donors from the cleaned CSV (dgm_donors_for_ghl.csv) into a
school's GHL location. Upserts by email (or by donor_dp_id custom field
when no email exists), so re-running is safe and idempotent.

For each row:
  - Look up existing contact by email (lowercased); fallback: search by
    donor_dp_id custom field; otherwise create new.
  - Map standard fields (firstName, lastName, email, phone, address1,
    city, state, postalCode) onto the GHL contact base.
  - Map all donor_* custom fields by the field schema we created in
    scripts/setup-donor-fields-in-ghl.py.
  - Apply native GHL tags from the Tags column (comma-separated,
    `donor:individual, donor:mid-donor` style).
  - Stash the GHL contact_id back into dp_donors.ghl_contact_id so the
    dashboard's "Open Full Contact Record" link works for everyone.

Usage:
    DATABASE_URL=... ENCRYPTION_KEY=... \\
      python scripts/import-cleaned-donors-to-ghl.py \\
        --school-id <uuid> \\
        --csv "dgm_donors_for_ghl.csv" \\
        [--rate 6] [--limit N] [--dry-run]
"""
import argparse
import base64
import csv
import os
import re
import sys
import time
import psycopg2
import requests


# ------------- Field-key mapping for the cleaned-CSV columns -----------
# (CSV column header → GHL fieldKey created by setup-donor-fields-in-ghl.py)
CUSTOM_FIELD_MAP = {
    # bio / identity
    "Donor ID":              "donor_dp_id",
    "Is Organization":       "donor_is_organization",
    "Title":                 "donor_title",
    "Professional Title":    "donor_professional_title",
    "Suffix":                "donor_suffix",
    "Salutation":            "donor_salutation",
    "Opt Line":              "donor_opt_line",
    "Address Line 2":        "donor_address_line_2",
    "State Description":     "donor_state_description",
    "Business Phone":        "donor_business_phone",
    "Mobile Phone":          "donor_mobile_phone",
    "Home Phone":            "donor_home_phone",
    "LinkedIn":              "donor_linkedin",
    "Facebook":              "donor_facebook",
    "Social Media":          "donor_social_media",
    "Additional Notes":      "donor_additional_notes",
    "Volunteer Notes":       "donor_volunteer_notes",
    # gift aggregates
    "Lifetime Gift Total":   "donor_lifetime_giving",   # share with the original 8
    "Total Gifts Count":     "donor_gifts_count",
    "First Gift Date":       "donor_first_gift_date",
    "Last Gift Date":        "donor_last_gift_date",
    "Largest Gift":          "donor_largest_gift",
    "Average Gift Size":     "donor_avg_gift_size",
    "Current Year YTD (2026)": "donor_current_ytd_calendar",
    "Last Year YTD (from source)": "donor_ly_cytd_source",
    "Lifetime Total (from source)": "donor_lifetime_source",
    "Donor Segment":         "donor_tier",
}


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
    """fieldKey -> field id, for every donor_* field on the location."""
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
    missing = [v for v in CUSTOM_FIELD_MAP.values() if v not in out]
    if missing:
        sys.exit(
            f"Missing fields in GHL: {missing}\n"
            f"Run scripts/setup-donor-fields-in-ghl.py first."
        )
    return out


def search_by_email(session, location_id, pit, email):
    """Return existing contact id by lowercased email, or None."""
    needle = email.strip().lower()
    if not needle:
        return None
    r = session.post(
        "https://services.leadconnectorhq.com/contacts/search",
        json={
            "locationId": location_id,
            "pageLimit": 5,
            "page": 1,
            "filters": [{"field": "email", "operator": "eq", "value": needle}],
        },
        headers={
            "Authorization": f"Bearer {pit}",
            "Version": "2021-07-28",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"search by email {r.status_code}: {r.text[:200]}")
    for c in r.json().get("contacts", []):
        if (c.get("email") or "").strip().lower() == needle:
            return c["id"]
    return None


def search_by_dp_id(session, location_id, pit, dp_id_field_id, dp_id):
    """Return contact id where donor_dp_id custom field matches, or None.
    Used for orgs / contacts without email so re-runs don't duplicate."""
    if not dp_id:
        return None
    # GHL filter on custom field id with 'eq' operator
    r = session.post(
        "https://services.leadconnectorhq.com/contacts/search",
        json={
            "locationId": location_id,
            "pageLimit": 5,
            "page": 1,
            "filters": [{
                "field": f"customFields.{dp_id_field_id}",
                "operator": "eq",
                "value": str(dp_id),
            }],
        },
        headers={
            "Authorization": f"Bearer {pit}",
            "Version": "2021-07-28",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    if r.status_code >= 400:
        # Some GHL filter shapes return 400 for custom-field eq — fall back to "search by name"
        return None
    for c in r.json().get("contacts", []):
        return c.get("id")
    return None


def build_contact_body(row, field_ids, location_id):
    """Returns the request body for create/update."""
    standard = {
        "locationId": location_id,
        # GHL requires firstName+lastName OR a name. For organizations
        # (no first name), put the org name in lastName so the contact
        # has a display name.
        "firstName": row.get("First Name", "").strip(),
        "lastName": row.get("Last Name", "").strip(),
    }
    if row.get("Email", "").strip():
        standard["email"] = row["Email"].strip().lower()
    if row.get("Phone", "").strip():
        standard["phone"] = row["Phone"].strip()
    if row.get("Address", "").strip():
        standard["address1"] = row["Address"].strip()
    if row.get("City", "").strip():
        standard["city"] = row["City"].strip()
    if row.get("State", "").strip():
        standard["state"] = row["State"].strip()
    if row.get("Postal Code", "").strip():
        standard["postalCode"] = row["Postal Code"].strip()

    # Tags — comma-separated; pass as native GHL tags
    tags_csv = (row.get("Tags") or "").strip()
    if tags_csv:
        tags = [t.strip() for t in tags_csv.split(",") if t.strip()]
        if tags:
            standard["tags"] = tags

    # Custom fields
    custom_fields = []
    for csv_col, ghl_key in CUSTOM_FIELD_MAP.items():
        raw = row.get(csv_col, "")
        if raw is None:
            continue
        value = _coerce_value(raw, ghl_key)
        if value is None or value == "":
            continue
        field_id = field_ids.get(ghl_key)
        if not field_id:
            continue
        custom_fields.append({"id": field_id, "field_value": value})
    if custom_fields:
        standard["customFields"] = custom_fields

    return standard


def _coerce_value(raw, ghl_key):
    """Strip $/commas for money columns; pass through everything else as
    a trimmed string. Empty after coercion → return ''."""
    s = str(raw).strip()
    if not s:
        return ""
    # Money fields: strip $ and commas
    money_fields = {
        "donor_lifetime_giving", "donor_largest_gift", "donor_avg_gift_size",
        "donor_current_ytd_calendar", "donor_ly_cytd_source", "donor_lifetime_source",
    }
    if ghl_key in money_fields:
        cleaned = re.sub(r"[\$,\s]", "", s).strip("()") or "0"
        try:
            return float(cleaned)
        except ValueError:
            return ""
    # Donor tier: matches RADIO option strings exactly
    if ghl_key == "donor_tier":
        # CSV values: "Prospect (no gifts)" / "Micro Donor" / etc. — match as-is
        return s
    # Number / date fields can stay as strings (GHL coerces)
    return s


def upsert_contact(session, location_id, pit, contact_id, body):
    """If contact_id given, PUT to update; else POST to create.
    On POST, GHL may 400 with `This location does not allow duplicated
    contacts` and helpfully include the existing contactId in the body.
    When that happens we retry as a PUT to the existing id — that's
    exactly the upsert behavior we want."""
    headers = {
        "Authorization": f"Bearer {pit}",
        "Version": "2021-07-28",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if contact_id:
        # PUT path — strip locationId
        clean = {k: v for k, v in body.items() if k != "locationId"}
        r = session.put(
            f"https://services.leadconnectorhq.com/contacts/{contact_id}",
            json=clean, headers=headers, timeout=30,
        )
        if r.status_code >= 400:
            return None, f"PUT {r.status_code} {r.text[:300]}"
        return (r.json().get("contact") or {}).get("id") or contact_id, None

    # POST (create) path
    r = session.post(
        "https://services.leadconnectorhq.com/contacts/",
        json=body, headers=headers, timeout=30,
    )
    if r.status_code < 400:
        return (r.json().get("contact") or {}).get("id"), None

    # Duplicate-contact recovery: GHL returns 400 with the existing id
    if r.status_code == 400:
        try:
            data = r.json()
            msg = (data.get("message") or "").lower()
            existing_id = (data.get("meta") or {}).get("contactId")
            if "duplicated" in msg and existing_id:
                # Retry as PUT to the existing contact
                clean = {k: v for k, v in body.items() if k != "locationId"}
                pr = session.put(
                    f"https://services.leadconnectorhq.com/contacts/{existing_id}",
                    json=clean, headers=headers, timeout=30,
                )
                if pr.status_code >= 400:
                    return None, f"POST 400 dup-retry PUT {pr.status_code} {pr.text[:200]}"
                return (pr.json().get("contact") or {}).get("id") or existing_id, None
        except Exception:
            pass

    return None, f"POST {r.status_code} {r.text[:300]}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--csv", required=True, help="Path to dgm_donors_for_ghl.csv")
    p.add_argument("--rate", type=float, default=6.0, help="GHL req/sec (default 6)")
    p.add_argument("--limit", type=int, default=0, help="stop after N rows (debugging)")
    p.add_argument("--dry-run", action="store_true")
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
    dp_id_field_id = field_ids["donor_dp_id"]
    print(f"Field ids resolved: {len(field_ids)} total ({len(CUSTOM_FIELD_MAP)} mapped from CSV)")

    # Preload our dp_donors → ghl_contact_id map so we skip a search for
    # the 395 contacts we already enriched + parent-matched.
    cur.execute(
        """SELECT d.dp_donor_id, COALESCE(d.ghl_contact_id, p.ghl_contact_id)
           FROM dp_donors d
           LEFT JOIN parents p ON p.id = d.matched_parent_id
           WHERE d.school_id = %s
             AND (d.ghl_contact_id IS NOT NULL OR p.ghl_contact_id IS NOT NULL)""",
        (args.school_id,),
    )
    preknown = {row[0]: row[1] for row in cur.fetchall()}
    print(f"Pre-known contact ids from prior enrichment: {len(preknown)}")

    rows = []
    with open(args.csv, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    if args.limit and len(rows) > args.limit:
        rows = rows[:args.limit]
    print(f"CSV rows to process: {len(rows)}")

    created = 0
    updated = 0
    failed = 0
    err_samples = []
    min_interval = 1.0 / max(args.rate, 0.1)
    last_call = 0.0

    for i, row in enumerate(rows):
        dp_id = (row.get("Donor ID") or "").strip()
        email = (row.get("Email") or "").strip().lower()

        # Resolve existing contact id (3-tier fallback)
        existing_id = preknown.get(dp_id)
        try:
            if not existing_id and email:
                wait = (last_call + min_interval) - time.time()
                if wait > 0:
                    time.sleep(wait)
                last_call = time.time()
                existing_id = search_by_email(session, location_id, pit, email)
            if not existing_id and not email and dp_id:
                wait = (last_call + min_interval) - time.time()
                if wait > 0:
                    time.sleep(wait)
                last_call = time.time()
                existing_id = search_by_dp_id(session, location_id, pit, dp_id_field_id, dp_id)
        except Exception as e:
            failed += 1
            if len(err_samples) < 5:
                err_samples.append(f"row {i+1} (dp_id={dp_id}): lookup failed: {e}")
            continue

        body = build_contact_body(row, field_ids, location_id)
        # Guard: GHL requires at least firstName OR lastName
        if not body.get("firstName") and not body.get("lastName"):
            failed += 1
            if len(err_samples) < 5:
                err_samples.append(f"row {i+1} (dp_id={dp_id}): no name")
            continue

        if args.dry_run:
            if i < 3:
                action = "UPDATE" if existing_id else "CREATE"
                print(f"  [dry] {action} dp_id={dp_id} email={email or '-'} "
                      f"fields={len(body.get('customFields', []))} tags={len(body.get('tags', []))}")
            continue

        wait = (last_call + min_interval) - time.time()
        if wait > 0:
            time.sleep(wait)
        last_call = time.time()

        new_id, err = upsert_contact(session, location_id, pit, existing_id, body)
        if err:
            failed += 1
            if len(err_samples) < 5:
                err_samples.append(f"row {i+1} (dp_id={dp_id}): {err}")
        else:
            if existing_id:
                updated += 1
            else:
                created += 1
            # Persist back to dp_donors so the dashboard link works for all
            if new_id:
                try:
                    cur.execute(
                        """UPDATE dp_donors
                           SET ghl_contact_id = %s,
                               ghl_contact_lookup_at = now(),
                               ghl_contact_lookup_result = 'imported'
                           WHERE school_id = %s AND dp_donor_id = %s""",
                        (new_id, args.school_id, dp_id),
                    )
                    if i % 25 == 0:
                        conn.commit()
                except Exception:
                    pass

        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(rows)}  created={created} updated={updated} failed={failed}")

    conn.commit()
    cur.close()
    conn.close()

    print()
    print(f"=== Done: {created} created, {updated} updated, {failed} failed ===")
    for s in err_samples:
        print(f"  err: {s}")


if __name__ == "__main__":
    main()
