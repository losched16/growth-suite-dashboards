"""
Lists all custom fields on a GHL location. Also compares against the
field set required by the reshape-enrollment-csv output, so we know
exactly which fields are missing and need to be created.

USAGE:
  python scripts/list-ghl-custom-fields.py <location_id> <pit_token>

Doesn't write to anything — pure read.
"""

from __future__ import annotations

import sys
import json
import requests

GHL_BASE = 'https://services.leadconnectorhq.com'
GHL_VERSION = '2021-07-28'

# Fields we want available on every contact for the enrollment-import
# flow. Each is (display_name, key_hint, type).  GHL stores its own
# key (usually lowercase snake_case derived from the name); we'll match
# loosely by display name AND key when comparing.
REQUIRED_FIELDS = [
    # ── Family / household ──────────────────────────────────────────
    ('Family Display Name',        'family_display_name',          'TEXT'),
    ('Family Address',             'family_address',               'LARGE_TEXT'),

    # ── Parent 2 (the GHL contact IS parent 1 — these are P2 mirror) ─
    ('Parent 2 First Name',        'parent2_first_name',           'TEXT'),
    ('Parent 2 Last Name',         'parent2_last_name',            'TEXT'),
    ('Parent 2 Email',             'parent2_email',                'TEXT'),
    ('Parent 2 Phone',             'parent2_phone',                'PHONE'),

    # ── Student 1 ───────────────────────────────────────────────────
    ('Student 1 First Name',       'student1_first_name',          'TEXT'),
    ('Student 1 Last Name',        'student1_last_name',           'TEXT'),
    ('Student 1 DOB',              'student1_dob',                 'DATE'),
    ('Student 1 Grade',            'student1_grade',               'TEXT'),
    ('Student 1 Classroom',        'student1_classroom',           'TEXT'),
    ('Student 1 Schedule Days',    'student1_schedule_days',       'TEXT'),
    ('Student 1 Schedule Times',   'student1_schedule_times',      'TEXT'),
    ('Student 1 Allergies',        'student1_allergies',           'LARGE_TEXT'),
    ('Student 1 Nap',              'student1_nap',                 'TEXT'),
    ('Student 1 Aftercare',        'student1_aftercare',           'TEXT'),
    ('Student 1 Is New',           'student1_is_new',              'TEXT'),
    ('Student 1 Start Date',       'student1_start_date',          'TEXT'),
    ('Student 1 Comments',         'student1_comments',            'LARGE_TEXT'),

    # ── Student 2 ───────────────────────────────────────────────────
    ('Student 2 First Name',       'student2_first_name',          'TEXT'),
    ('Student 2 Last Name',        'student2_last_name',           'TEXT'),
    ('Student 2 DOB',              'student2_dob',                 'DATE'),
    ('Student 2 Grade',            'student2_grade',               'TEXT'),
    ('Student 2 Classroom',        'student2_classroom',           'TEXT'),
    ('Student 2 Schedule Days',    'student2_schedule_days',       'TEXT'),
    ('Student 2 Schedule Times',   'student2_schedule_times',      'TEXT'),
    ('Student 2 Allergies',        'student2_allergies',           'LARGE_TEXT'),
    ('Student 2 Nap',              'student2_nap',                 'TEXT'),
    ('Student 2 Aftercare',        'student2_aftercare',           'TEXT'),
    ('Student 2 Is New',           'student2_is_new',              'TEXT'),
    ('Student 2 Start Date',       'student2_start_date',          'TEXT'),
    ('Student 2 Comments',         'student2_comments',            'LARGE_TEXT'),

    # ── Student 3 (extra capacity) ──────────────────────────────────
    ('Student 3 First Name',       'student3_first_name',          'TEXT'),
    ('Student 3 Last Name',        'student3_last_name',           'TEXT'),
    ('Student 3 DOB',              'student3_dob',                 'DATE'),
    ('Student 3 Grade',            'student3_grade',               'TEXT'),
    ('Student 3 Classroom',        'student3_classroom',           'TEXT'),
    ('Student 3 Schedule Days',    'student3_schedule_days',       'TEXT'),
    ('Student 3 Schedule Times',   'student3_schedule_times',      'TEXT'),
    ('Student 3 Allergies',        'student3_allergies',           'LARGE_TEXT'),
    ('Student 3 Nap',              'student3_nap',                 'TEXT'),
    ('Student 3 Aftercare',        'student3_aftercare',           'TEXT'),
    ('Student 3 Is New',           'student3_is_new',              'TEXT'),
    ('Student 3 Start Date',       'student3_start_date',          'TEXT'),
    ('Student 3 Comments',         'student3_comments',            'LARGE_TEXT'),
]


def list_custom_fields(location_id: str, pit: str) -> list[dict]:
    """Returns the raw list from GHL. Each dict has at minimum
    {id, name, fieldKey, dataType, ...}."""
    url = f'{GHL_BASE}/locations/{location_id}/customFields'
    headers = {
        'Authorization': f'Bearer {pit}',
        'Version': GHL_VERSION,
        'Accept': 'application/json',
    }
    r = requests.get(url, headers=headers, timeout=30)
    if not r.ok:
        print(f'ERROR {r.status_code}: {r.text[:500]}', file=sys.stderr)
        r.raise_for_status()
    data = r.json()
    # GHL returns { customFields: [...] }
    return data.get('customFields', [])


def normalize(s: str) -> str:
    """Lowercased + alphanumerics only — for loose match between
    display names and field keys."""
    return ''.join(c.lower() for c in s if c.isalnum())


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print('Usage: python scripts/list-ghl-custom-fields.py <location_id> <pit>', file=sys.stderr)
        return 1
    location_id = argv[1]
    pit = argv[2]

    print(f'Querying GHL location {location_id}...')
    existing = list_custom_fields(location_id, pit)
    print(f'Found {len(existing)} custom field(s) on this location.')
    print()

    # ── Section 1: dump everything that's already there ──────────────
    print('=' * 70)
    print(f'  EXISTING CUSTOM FIELDS ({len(existing)})')
    print('=' * 70)
    if not existing:
        print('  (none)')
    else:
        # Sort by name for readability
        for f in sorted(existing, key=lambda x: (x.get('name') or '').lower()):
            name = f.get('name', '?')
            key = f.get('fieldKey', f.get('key', '?'))
            dtype = f.get('dataType', '?')
            print(f'  - {name:<40}  key={key:<35}  type={dtype}')
    print()

    # ── Section 2: compare to required ───────────────────────────────
    # Build a lookup keyed by normalized name + by normalized key.
    by_norm = {}
    for f in existing:
        n = (f.get('name') or '')
        k = f.get('fieldKey') or f.get('key') or ''
        by_norm[normalize(n)] = f
        if k:
            by_norm[normalize(k)] = f
            # GHL prefixes some keys with "contact." — strip it for matching.
            if '.' in k:
                by_norm[normalize(k.split('.', 1)[1])] = f

    have, missing = [], []
    for display, hint, dtype in REQUIRED_FIELDS:
        match = by_norm.get(normalize(display)) or by_norm.get(normalize(hint))
        (have if match else missing).append((display, hint, dtype, match))

    print('=' * 70)
    print(f'  REQUIRED FOR ENROLLMENT IMPORT — comparison')
    print('=' * 70)
    print(f'  Found:   {len(have)} of {len(REQUIRED_FIELDS)}')
    print(f'  Missing: {len(missing)} (will need to be created)')
    print()

    if have:
        print('  ALREADY EXISTS:')
        for display, hint, _dtype, match in have:
            existing_key = match.get('fieldKey') or match.get('key') or '(no key)'
            print(f'    + {display:<35} -> {existing_key}')
        print()

    if missing:
        print('  TO CREATE:')
        for display, hint, dtype, _ in missing:
            print(f'    - {display:<35} (suggested key: {hint:<30} type: {dtype})')

    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
