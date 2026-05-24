"""
Idempotent: creates the 8 donor-summary custom fields in a school's GHL
location if they don't already exist (matched by fieldKey). Safe to
re-run; existing fields are left alone.

Fields created (on the contact model):
  donor_lifetime_giving   MONETORY
  donor_last_gift_date    DATE
  donor_last_gift_amount  MONETORY
  donor_gifts_count       NUMERICAL
  donor_ytd_giving        MONETORY
  donor_segment           TEXT
  donor_tags              LARGE_TEXT     (comma-joined; readable + searchable)
  is_donor                RADIO          (Yes/No)

Usage:
    DATABASE_URL=postgres://... ENCRYPTION_KEY=... \\
      python scripts/setup-donor-fields-in-ghl.py --school-id <uuid>
"""
import argparse
import os
import sys
import base64
import psycopg2
import requests


# The full donor field set. Some of these existed from the original
# 8-field sync we ran first; new ones are appended below from the
# cleaned-CSV schema. Re-running this script is safe (idempotent —
# skips fields whose fieldKey already exists in the school's GHL).
FIELDS_TO_ENSURE = [
    # ----- Original 8 fields (donor summary, populated by sync-donors-to-ghl.py) -----
    {"name": "Donor — Lifetime Giving",     "fieldKey": "donor_lifetime_giving",  "dataType": "MONETORY",   "placeholder": "Total lifetime giving"},
    {"name": "Donor — Last Gift Date",      "fieldKey": "donor_last_gift_date",   "dataType": "DATE",       "placeholder": "Most recent gift date"},
    {"name": "Donor — Last Gift Amount",    "fieldKey": "donor_last_gift_amount", "dataType": "MONETORY",   "placeholder": "Amount of most recent gift"},
    {"name": "Donor — Gift Count",          "fieldKey": "donor_gifts_count",      "dataType": "NUMERICAL",  "placeholder": "Total number of gifts to date"},
    {"name": "Donor — YTD Giving (school year)", "fieldKey": "donor_ytd_giving",  "dataType": "MONETORY",   "placeholder": "Giving in the current school year"},
    {"name": "Donor — Segment (relationship)",   "fieldKey": "donor_segment",     "dataType": "TEXT",       "placeholder": "business / current_family / alumni_family / individual"},
    {"name": "Donor — Tags",                "fieldKey": "donor_tags",             "dataType": "LARGE_TEXT", "placeholder": "Comma-joined operator tags"},
    {"name": "Is Donor",                    "fieldKey": "is_donor",               "dataType": "RADIO",      "placeholder": "Yes if this contact has ever given.",
     "picklistOptions": ["Yes", "No"]},

    # ----- Identity / bio (from the cleaned CSV) -----
    {"name": "Donor — DonorPerfect ID",     "fieldKey": "donor_dp_id",            "dataType": "TEXT",       "placeholder": "Unique ID from DonorPerfect"},
    {"name": "Donor — Is Organization",     "fieldKey": "donor_is_organization",  "dataType": "RADIO",      "placeholder": "Yes = corporate/foundation donor; No = individual",
     "picklistOptions": ["Yes", "No"]},
    {"name": "Donor — Title",               "fieldKey": "donor_title",            "dataType": "TEXT",       "placeholder": "Mr., Mrs., Dr., etc."},
    {"name": "Donor — Professional Title",  "fieldKey": "donor_professional_title", "dataType": "TEXT",     "placeholder": "e.g. VP of Sales"},
    {"name": "Donor — Suffix",              "fieldKey": "donor_suffix",           "dataType": "TEXT",       "placeholder": "Jr., Sr., III, etc."},
    {"name": "Donor — Salutation",          "fieldKey": "donor_salutation",       "dataType": "TEXT",       "placeholder": "Informal greeting name used in correspondence"},
    {"name": "Donor — Opt Line",            "fieldKey": "donor_opt_line",         "dataType": "TEXT",       "placeholder": "Optional address line for company name, attention, etc."},
    {"name": "Donor — Address Line 2",      "fieldKey": "donor_address_line_2",   "dataType": "TEXT",       "placeholder": ""},
    {"name": "Donor — State (full name)",   "fieldKey": "donor_state_description","dataType": "TEXT",       "placeholder": "e.g. Arizona"},
    {"name": "Donor — Business Phone",      "fieldKey": "donor_business_phone",   "dataType": "PHONE",      "placeholder": ""},
    {"name": "Donor — Mobile Phone",        "fieldKey": "donor_mobile_phone",     "dataType": "PHONE",      "placeholder": ""},
    {"name": "Donor — Home Phone",          "fieldKey": "donor_home_phone",       "dataType": "PHONE",      "placeholder": ""},
    {"name": "Donor — LinkedIn",            "fieldKey": "donor_linkedin",         "dataType": "TEXT",       "placeholder": "URL"},
    {"name": "Donor — Facebook",            "fieldKey": "donor_facebook",         "dataType": "TEXT",       "placeholder": "URL"},
    {"name": "Donor — Social Media",        "fieldKey": "donor_social_media",     "dataType": "TEXT",       "placeholder": "Other social handles"},
    {"name": "Donor — Additional Notes",    "fieldKey": "donor_additional_notes", "dataType": "LARGE_TEXT", "placeholder": ""},
    {"name": "Donor — Volunteer Notes",     "fieldKey": "donor_volunteer_notes",  "dataType": "LARGE_TEXT", "placeholder": ""},

    # ----- Gift aggregates (richer than the original 8) -----
    {"name": "Donor — First Gift Date",     "fieldKey": "donor_first_gift_date",  "dataType": "DATE",       "placeholder": "Earliest gift on record"},
    {"name": "Donor — Largest Gift",        "fieldKey": "donor_largest_gift",     "dataType": "MONETORY",   "placeholder": "Single largest gift amount"},
    {"name": "Donor — Average Gift Size",   "fieldKey": "donor_avg_gift_size",    "dataType": "MONETORY",   "placeholder": "Mean across all gifts"},
    {"name": "Donor — YTD Giving (calendar year)", "fieldKey": "donor_current_ytd_calendar", "dataType": "MONETORY", "placeholder": "Calendar-year YTD (Jan 1 boundary)"},
    {"name": "Donor — Source LY CYTD",      "fieldKey": "donor_ly_cytd_source",   "dataType": "MONETORY",   "placeholder": "Pre-computed LY_CYTD from DonorPerfect"},
    {"name": "Donor — Source Lifetime",     "fieldKey": "donor_lifetime_source",  "dataType": "MONETORY",   "placeholder": "Pre-computed GIFT_TOTAL from DonorPerfect"},

    # ----- Donor tier (giving-size based; complements donor_segment relationship-based) -----
    {"name": "Donor — Tier",                "fieldKey": "donor_tier",             "dataType": "RADIO",      "placeholder": "Giving-size tier",
     "picklistOptions": ["Prospect (no gifts)", "Micro Donor", "Small Donor", "Mid Donor", "Major Donor", "Top Donor"]},
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
    pit = AESGCM(key).decrypt(iv, ct + tag, None).decode("utf-8")
    return loc, pit


def list_existing_fields(session, location_id, pit):
    """Returns dict { normalized fieldKey -> field record }."""
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
        sys.exit(f"GHL listCustomFields failed: {r.status_code} {r.text[:300]}")
    out = {}
    for f in r.json().get("customFields", []):
        raw = (f.get("fieldKey") or "").replace("contact.", "")
        if raw:
            out[raw] = f
    return out


def create_field(session, location_id, pit, spec):
    # GHL v2 rejects locationId in the body (it's in the path).
    # RADIO / CHECKBOX / SINGLE_OPTIONS / MULTIPLE_OPTIONS need `options`
    # as an array of { id, key, name, isSelected } objects in their API.
    body = {
        "name": spec["name"],
        "dataType": spec["dataType"],
        "fieldKey": spec["fieldKey"],
        "model": "contact",
        "placeholder": spec.get("placeholder", ""),
    }
    if "picklistOptions" in spec:
        # GHL accepts options as a flat array of strings for RADIO /
        # CHECKBOX / SINGLE_OPTIONS / MULTIPLE_OPTIONS. (We tried the
        # {key, name} object shape — server choked on `v.trim is not a
        # function`, so v2 wants plain strings.)
        body["options"] = list(spec["picklistOptions"])
    r = session.post(
        f"https://services.leadconnectorhq.com/locations/{location_id}/customFields",
        json=body,
        headers={
            "Authorization": f"Bearer {pit}",
            "Version": "2021-07-28",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    if r.status_code >= 400:
        return None, f"{r.status_code} {r.text[:300]}"
    data = r.json()
    return data.get("customField") or data, None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--dry-run", action="store_true",
                   help="show what would be created without making API calls")
    args = p.parse_args()

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL env var required")

    conn = psycopg2.connect(db)
    cur = conn.cursor()
    location_id, pit = fetch_pit(cur, args.school_id)
    cur.close()
    conn.close()
    print(f"School GHL location: {location_id}")

    session = requests.Session()
    existing = list_existing_fields(session, location_id, pit)
    print(f"Existing custom fields in school: {len(existing)}")

    created = 0
    skipped = 0
    errors = 0
    for spec in FIELDS_TO_ENSURE:
        key = spec["fieldKey"]
        if key in existing:
            print(f"  [skip] {key:30s} already exists (id={existing[key]['id']})")
            skipped += 1
            continue
        if args.dry_run:
            print(f"  [dry]  would create {key} ({spec['dataType']})")
            continue
        cf, err = create_field(session, location_id, pit, spec)
        if err:
            print(f"  [err]  {key:30s} {err}")
            errors += 1
        else:
            print(f"  [ok]   {key:30s} created (id={cf.get('id', '?')})")
            created += 1

    print()
    print(f"=== Done: {created} created, {skipped} skipped (already existed), {errors} errors ===")


if __name__ == "__main__":
    main()
