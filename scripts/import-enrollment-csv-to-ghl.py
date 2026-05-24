"""
Imports a reshaped enrollment CSV (one row per family) into GHL as
contacts with all the custom fields populated. Idempotent: matches by
Parent 1 email and updates if the contact exists.

USAGE:
  python scripts/import-enrollment-csv-to-ghl.py \\
      <families.csv> <location_id> <pit> [--apply]

By default this is a DRY RUN — it'll show you exactly what would
happen, contact by contact. Pass --apply to actually hit GHL.

Tags applied to every imported contact:
  - current-family             (mark them as enrolled for workflow filtering)
  - imported-from-spreadsheet  (provenance — easy to find/revert this batch)

Native GHL fields set from the CSV:
  - firstName, lastName, email, phone  (Parent 1)
  - address1                            (family address)

Custom fields set:
  - Family Display Name, Family Address
  - Parent 2 First Name / Last Name / Email / Phone
  - Student First/Last Name, DOB, Grade, Classroom, Schedule Days/Times,
    Allergies, Nap, Aftercare, Is New, Start Date, Comments
  - Same for Student 2 and Student 3

Outputs an audit CSV alongside the input:
  <input>__ghl-import-log.csv

with columns: family_display_name, parent1_email, ghl_contact_id, action
"""

from __future__ import annotations

import csv
import sys
import time
from pathlib import Path
import requests

GHL_BASE = 'https://services.leadconnectorhq.com'
GHL_VERSION = '2021-07-28'
TAGS_TO_ADD = ['current-family', 'imported-from-spreadsheet']

# ── CSV column → GHL custom field display name mapping ───────────────
# Native columns (firstName/lastName/email/phone) are handled separately.
# Anything in this map writes into customFields[].

CSV_TO_GHL_FIELD: dict[str, str] = {
    # Family-level
    'family_display_name':       'Family Display Name',
    'address':                   'Family Address',
    # Parent 2 (parent 1 = the contact itself)
    'parent2_first_name':        'Parent 2 First Name',
    'parent2_last_name':         'Parent 2 Last Name',
    'parent2_email':             'Parent 2 Email',
    'parent2_phone':             'Parent 2 Phone',
}

# Per-student field mapping. Student 1 in CSV → "Student X" in GHL (no
# number). Student 2 → "Student 2 X". Student 3 → "Student 3 X". This
# mirrors the naming convention Media already uses on their location.
STUDENT_FIELD_SUFFIX: dict[str, str] = {
    'first_name':     'First Name',
    'last_name':      'Last Name',
    'dob':            'DOB',
    'grade':          'Grade',
    'classroom':      'Classroom',
    'schedule_days':  'Schedule Days',
    'schedule_times': 'Schedule Times',
    'allergies':      'Allergies',
    'nap':            'Nap',
    'aftercare':      'Aftercare',
    'is_new':         'Is New',
    'start_date':     'Start Date',
    'comments':       'Comments',
}

def expand_student_columns(student_num: int) -> dict[str, str]:
    """Returns a CSV-column → GHL-display-name map for student N."""
    out = {}
    csv_prefix = f'student{student_num}_'
    ghl_prefix = 'Student' if student_num == 1 else f'Student {student_num}'
    for csv_suffix, ghl_suffix in STUDENT_FIELD_SUFFIX.items():
        out[f'{csv_prefix}{csv_suffix}'] = f'{ghl_prefix} {ghl_suffix}'
    return out

# Build the full CSV→GHL field-name map (family + students 1/2/3)
FULL_FIELD_MAP = {
    **CSV_TO_GHL_FIELD,
    **expand_student_columns(1),
    **expand_student_columns(2),
    **expand_student_columns(3),
}

# ── HTTP helpers ─────────────────────────────────────────────────────

def ghl_headers(pit: str) -> dict[str, str]:
    return {
        'Authorization': f'Bearer {pit}',
        'Version': GHL_VERSION,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }

def list_custom_fields(location_id: str, pit: str) -> list[dict]:
    url = f'{GHL_BASE}/locations/{location_id}/customFields'
    r = requests.get(url, headers=ghl_headers(pit), timeout=30)
    r.raise_for_status()
    return r.json().get('customFields', [])

def find_contact_by_email(location_id: str, pit: str, email: str) -> dict | None:
    if not email:
        return None
    needle = email.strip().lower()
    body = {
        'locationId': location_id,
        'pageLimit': 5, 'page': 1,
        'filters': [{'field': 'email', 'operator': 'eq', 'value': needle}],
    }
    r = requests.post(f'{GHL_BASE}/contacts/search', headers=ghl_headers(pit), json=body, timeout=30)
    if not r.ok:
        return None
    for c in r.json().get('contacts', []) or []:
        if (c.get('email') or '').strip().lower() == needle:
            return c
    return None

def create_contact(location_id: str, pit: str, body: dict) -> dict:
    body = {**body, 'locationId': location_id}
    r = requests.post(f'{GHL_BASE}/contacts/', headers=ghl_headers(pit), json=body, timeout=30)
    if not r.ok:
        try: err = r.json()
        except Exception: err = r.text
        raise RuntimeError(f'create {r.status_code}: {err}')
    return r.json().get('contact', {})

def update_contact(pit: str, contact_id: str, body: dict) -> dict:
    # GHL's update endpoint forbids locationId in the body.
    body = {k: v for k, v in body.items() if k != 'locationId'}
    r = requests.put(f'{GHL_BASE}/contacts/{contact_id}', headers=ghl_headers(pit), json=body, timeout=30)
    if not r.ok:
        try: err = r.json()
        except Exception: err = r.text
        raise RuntimeError(f'update {r.status_code}: {err}')
    return r.json().get('contact', {})

# ── Body builders ────────────────────────────────────────────────────

def clean(v: str | None) -> str:
    return (v or '').strip()

def build_contact_body(row: dict, field_id_by_name: dict[str, str]) -> dict:
    """Translate a families.csv row into a GHL contact body. Only
    non-empty values are included so we never blank out existing data
    in GHL with an empty cell from the spreadsheet."""
    body: dict = {}

    # Native fields (Parent 1)
    if clean(row.get('parent1_first_name')): body['firstName'] = clean(row['parent1_first_name'])
    if clean(row.get('parent1_last_name')):  body['lastName']  = clean(row['parent1_last_name'])
    if clean(row.get('parent1_email')):      body['email']     = clean(row['parent1_email'])
    if clean(row.get('parent1_phone')):      body['phone']     = clean(row['parent1_phone'])
    if clean(row.get('address')):            body['address1']  = clean(row['address'])

    # Tags
    body['tags'] = list(TAGS_TO_ADD)

    # Custom fields
    cfs = []
    for csv_col, ghl_name in FULL_FIELD_MAP.items():
        value = clean(row.get(csv_col, ''))
        if not value:
            continue
        field_id = field_id_by_name.get(ghl_name.lower())
        if not field_id:
            # Field doesn't exist on location — skip with a warning. The
            # create-fields script should have run first.
            continue
        cfs.append({'id': field_id, 'value': value})
    if cfs:
        body['customFields'] = cfs

    return body

def build_field_id_map(custom_fields: list[dict]) -> dict[str, str]:
    """name (lowercased) → field_id. Used so we can look up by display
    name from CSV_TO_GHL_FIELD / STUDENT_FIELD_SUFFIX."""
    out = {}
    for f in custom_fields:
        n = (f.get('name') or '').strip().lower()
        if n:
            out[n] = f.get('id') or f.get('_id') or ''
    return out

# ── Main ─────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 1
    csv_path = Path(argv[1])
    location_id = argv[2]
    pit = argv[3]
    apply_mode = '--apply' in argv

    if not csv_path.exists():
        print(f'CSV not found: {csv_path}', file=sys.stderr); return 1

    print(f'Loading {csv_path}')
    with csv_path.open('r', encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    print(f'  {len(rows)} family row(s)')

    print(f'Loading custom-field map for location {location_id}')
    cfs = list_custom_fields(location_id, pit)
    field_id_by_name = build_field_id_map(cfs)
    print(f'  {len(field_id_by_name)} field(s) on location')

    # Sanity-check: every field we expect to push exists on the location.
    missing_fields = [n for n in FULL_FIELD_MAP.values() if n.lower() not in field_id_by_name]
    if missing_fields:
        print()
        print('!! These required fields don\'t exist on the location:')
        for n in missing_fields:
            print(f'    - {n}')
        print('   Run create-ghl-custom-fields.py first.')
        return 2

    audit_rows: list[tuple] = []
    counts = {'create': 0, 'update': 0, 'skip': 0, 'fail': 0}

    for i, row in enumerate(rows, start=1):
        family = clean(row.get('family_display_name', ''))
        email = clean(row.get('parent1_email', ''))
        phone = clean(row.get('parent1_phone', ''))
        label = f'[{i:2d}/{len(rows)}] {family or "(unnamed)"}'

        if not email and not phone:
            print(f'  {label}: SKIP — no email or phone on parent 1')
            counts['skip'] += 1
            audit_rows.append((family, '', '', 'skipped-no-contact'))
            continue

        body = build_contact_body(row, field_id_by_name)

        if not apply_mode:
            # Dry run: just show what would happen.
            existing = find_contact_by_email(location_id, pit, email) if email else None
            action = 'WOULD UPDATE' if existing else 'WOULD CREATE'
            print(f'  {label}: {action} (email={email or "(none)"})  cf_count={len(body.get("customFields", []))}  tags={body.get("tags")}')
            audit_rows.append((family, email, existing.get('id', '') if existing else '', action.lower()))
            counts['update' if existing else 'create'] += 1
            continue

        try:
            existing = find_contact_by_email(location_id, pit, email) if email else None
            if existing:
                updated = update_contact(pit, existing['id'], body)
                cid = updated.get('id', existing['id'])
                print(f'  {label}: UPDATED {cid}')
                audit_rows.append((family, email, cid, 'updated'))
                counts['update'] += 1
            else:
                created = create_contact(location_id, pit, body)
                cid = created.get('id', '')
                print(f'  {label}: CREATED {cid}')
                audit_rows.append((family, email, cid, 'created'))
                counts['create'] += 1
            # Be nice to the API — small pause between rows.
            time.sleep(0.20)
        except Exception as e:
            print(f'  {label}: FAILED — {e}')
            audit_rows.append((family, email, '', f'failed:{e}'))
            counts['fail'] += 1

    # ── Write audit log ──
    out_path = csv_path.with_name(csv_path.stem + '__ghl-import-log.csv')
    with out_path.open('w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['family_display_name', 'parent1_email', 'ghl_contact_id', 'action'])
        w.writerows(audit_rows)

    print()
    print('=' * 60)
    print(f'  {"APPLIED" if apply_mode else "DRY RUN"} — summary')
    print('=' * 60)
    print(f'  Create:  {counts["create"]}')
    print(f'  Update:  {counts["update"]}')
    print(f'  Skip:    {counts["skip"]}')
    print(f'  Fail:    {counts["fail"]}')
    print(f'  Audit:   {out_path}')
    if not apply_mode:
        print()
        print('** Re-run with --apply to commit. **')
    return 0 if counts['fail'] == 0 else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
