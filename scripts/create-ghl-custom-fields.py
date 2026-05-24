"""
Creates any missing GHL custom fields on a location so that the
enrollment-CSV importer has somewhere to write its data. Matches the
school's existing naming pattern: "Student X" instead of "Student 1 X".

USAGE:
  python scripts/create-ghl-custom-fields.py <location_id> <pit> [--apply]

By default, runs a DRY RUN that lists what it WOULD do. Pass --apply to
actually hit the GHL API and create the fields.

Idempotent: re-running just skips fields that already exist.
"""

from __future__ import annotations

import sys
import time
import json
import requests

GHL_BASE = 'https://services.leadconnectorhq.com'
GHL_VERSION = '2021-07-28'

# REQUIRED_FIELDS: every custom field we need on a school's location to
# round-trip an enrollment-CSV row. Format: (display_name, dataType).
#
# Convention matches what Media already uses:
#   Student 1 → "Student X"    (no number)
#   Student 2 → "Student 2 X"
#   Student 3 → "Student 3 X"
#
# Native GHL contact fields (firstName, lastName, email, phone) cover
# parent 1 — we don't list them here.
REQUIRED_FIELDS: list[tuple[str, str]] = [
    # ── Family / household ──────────────────────────────────────────
    ('Family Display Name',         'TEXT'),
    ('Family Address',              'LARGE_TEXT'),

    # ── Parent 2 ────────────────────────────────────────────────────
    ('Parent 2 First Name',         'TEXT'),
    ('Parent 2 Last Name',          'TEXT'),
    ('Parent 2 Email',              'TEXT'),
    ('Parent 2 Phone',              'PHONE'),
]

# Per-student field templates. We materialize them for student 1 (no
# prefix), 2, 3.
STUDENT_FIELDS: list[tuple[str, str]] = [
    ('First Name',     'TEXT'),
    ('Last Name',      'TEXT'),
    ('DOB',            'DATE'),
    ('Grade',          'TEXT'),
    ('Classroom',      'TEXT'),
    ('Schedule Days',  'TEXT'),
    ('Schedule Times', 'TEXT'),
    ('Allergies',      'LARGE_TEXT'),
    ('Nap',            'TEXT'),
    ('Aftercare',      'TEXT'),
    ('Is New',         'TEXT'),
    ('Start Date',     'TEXT'),
    ('Comments',       'LARGE_TEXT'),
]


def expand_required() -> list[tuple[str, str]]:
    """Materialize REQUIRED_FIELDS + STUDENT_FIELDS × 3."""
    out = list(REQUIRED_FIELDS)
    # Student 1 — no prefix
    for suffix, dt in STUDENT_FIELDS:
        out.append((f'Student {suffix}', dt))
    # Student 2
    for suffix, dt in STUDENT_FIELDS:
        out.append((f'Student 2 {suffix}', dt))
    # Student 3
    for suffix, dt in STUDENT_FIELDS:
        out.append((f'Student 3 {suffix}', dt))
    return out


def normalize(s: str) -> str:
    return ''.join(c.lower() for c in s if c.isalnum())


def list_custom_fields(location_id: str, pit: str) -> list[dict]:
    url = f'{GHL_BASE}/locations/{location_id}/customFields'
    headers = {'Authorization': f'Bearer {pit}', 'Version': GHL_VERSION, 'Accept': 'application/json'}
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    return r.json().get('customFields', [])


def create_custom_field(location_id: str, pit: str, name: str, data_type: str) -> dict:
    url = f'{GHL_BASE}/locations/{location_id}/customFields'
    headers = {
        'Authorization': f'Bearer {pit}',
        'Version': GHL_VERSION,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
    body = {
        'name': name,
        'dataType': data_type,
        'model': 'contact',
        # `position` is optional — GHL appends if missing.
    }
    r = requests.post(url, headers=headers, json=body, timeout=30)
    if not r.ok:
        # Surface GHL's exact error so the operator can fix bad input.
        try:
            err = r.json()
        except Exception:
            err = r.text
        raise RuntimeError(f'{r.status_code} {name!r}: {err}')
    return r.json().get('customField', {})


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print('Usage: python scripts/create-ghl-custom-fields.py <location_id> <pit> [--apply]', file=sys.stderr)
        return 1
    location_id = argv[1]
    pit = argv[2]
    apply_mode = '--apply' in argv

    required = expand_required()
    print(f'Total fields required: {len(required)}')

    existing = list_custom_fields(location_id, pit)
    print(f'Existing on location: {len(existing)}')
    existing_by_norm: dict[str, dict] = {}
    for f in existing:
        n = f.get('name') or ''
        k = f.get('fieldKey') or f.get('key') or ''
        existing_by_norm[normalize(n)] = f
        if '.' in k:
            existing_by_norm[normalize(k.split('.', 1)[1])] = f
        else:
            existing_by_norm[normalize(k)] = f

    to_create: list[tuple[str, str]] = []
    already: list[tuple[str, str, str]] = []
    for name, dtype in required:
        match = existing_by_norm.get(normalize(name))
        if match:
            already.append((name, dtype, match.get('fieldKey') or match.get('key') or '?'))
        else:
            to_create.append((name, dtype))

    print()
    print('=' * 70)
    print(f'  Already exists: {len(already)}')
    print(f'  To create:      {len(to_create)}')
    print('=' * 70)

    if already:
        print()
        print('  Reusing existing:')
        for name, dtype, key in already:
            print(f'    + {name:<35} -> {key}')

    if not to_create:
        print()
        print('Nothing to do. All fields already present.')
        return 0

    print()
    print('  Will create:')
    for name, dtype in to_create:
        print(f'    - {name:<35} ({dtype})')

    if not apply_mode:
        print()
        print('** DRY RUN — re-run with --apply to actually create these in GHL. **')
        return 0

    print()
    print('Applying...')
    created = 0
    failed = []
    for name, dtype in to_create:
        try:
            f = create_custom_field(location_id, pit, name, dtype)
            fk = f.get('fieldKey') or f.get('key') or '(no key)'
            print(f'  CREATED  {name:<35} -> {fk}')
            created += 1
            # Be polite to the API — small pause between creates.
            time.sleep(0.15)
        except Exception as e:
            print(f'  FAILED   {name:<35}: {e}', file=sys.stderr)
            failed.append((name, str(e)))

    print()
    print('=' * 70)
    print(f'  Created: {created}')
    print(f'  Failed:  {len(failed)}')
    print('=' * 70)
    if failed:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
