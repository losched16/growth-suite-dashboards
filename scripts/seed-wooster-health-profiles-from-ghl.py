#!/usr/bin/env python3
"""
Pull per-student health data from Wooster's GHL custom fields into the
multi-tenant student_health_profiles table.

Wooster's GHL has ~105 health-related fields with two naming styles:

  1. Properly named slot fields: `student_2_medications`,
     `student_2_asthma`, `student_3_medications`, etc. Easy to map.

  2. Chaotic `_copy_copy_copy` fields where the field KEY is unreadable
     but the field NAME has a "(Student N)" prefix. E.g.
     fieldKey = `contactdoctor_name_7lh_copy_kht_copy`
     name     = "(Student 3) Doctor Name"
     We parse the slot from the name.

The script:
  1. Fetches the GHL field schema and classifies each field by
     (slot 1..4, target column).
  2. Fetches all Wooster enrolled contacts.
  3. For each contact, reads each student slot's data and upserts to
     student_health_profiles.

Modes:
  --dry-run   (default) parse + classify + summarize per-family changes;
              do not touch the DB.
  --commit    write to DB.

Usage:
  python scripts/seed-wooster-health-profiles-from-ghl.py --dry-run
  python scripts/seed-wooster-health-profiles-from-ghl.py --commit
"""

import argparse
import base64
import json
import re
import sys
from collections import defaultdict, Counter
from pathlib import Path

import psycopg2
import psycopg2.extras
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import requests

WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a'
ENROLLMENT_TAG = 'enrolled - 26/27'
GHL_BASE = 'https://services.leadconnectorhq.com'
GHL_VERSION = '2021-07-28'


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--dry-run', action='store_true', default=True)
    p.add_argument('--commit', action='store_true')
    args = p.parse_args()
    if args.commit:
        args.dry_run = False
    return args


def load_env():
    env_path = Path(__file__).parent.parent / '.env.local'
    env = {}
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
    return env


def decrypt_pit(env, ciphertext, iv, tag):
    key = base64.b64decode(env['ENCRYPTION_KEY'])
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(bytes(iv), bytes(ciphertext) + bytes(tag), None).decode('utf-8')


# Map a "semantic" key to the column in student_health_profiles.
# 'name_label' is the part of the field's "name" attribute that, when
# matched, signals this target.
TARGETS = [
    # (column, list of label substrings — case-insensitive, must NOT match other targets)
    ('primary_doctor_name', ['doctor name']),
    ('primary_doctor_phone', ['doctor phone']),
    ('preferred_hospital', ['hospital name']),
    ('health_insurance_provider', ['insurance company']),
    ('health_insurance_policy_number', ['policy number']),
    ('allergies', ['allergies']),
    ('current_medications', ['medications']),
    ('medical_conditions', ['existing medical conditions', 'medical conditions']),
]

# Some names overlap (e.g. "medications" is in "(Student 2) Medications"
# AND it's not in "Has Anaphylaxis Reaction"). To avoid false positives,
# we also reject any field whose name contains these blacklist strings.
NAME_BLACKLIST_SUBSTRINGS = [
    'medical administration', 'medication allergy', 'medical specialist',
]


def classify_field(field_name):
    """
    Given a GHL field name (e.g. "(Student 2) Doctor Name" or "Doctor Name"),
    return (slot_int_or_None, target_column_or_None). slot=1 for unprefixed,
    slot=N for "(Student N)" or "Student N -" prefixes.
    """
    if not field_name:
        return None, None
    name = field_name.strip()
    low = name.lower()

    # Reject obvious non-matches
    for bad in NAME_BLACKLIST_SUBSTRINGS:
        if bad in low and 'doctor' not in low and 'hospital' not in low:
            return None, None

    # Slot parsing
    slot = 1
    m = re.match(r'^\(student\s+(\d+)\)\s*', low)
    if m:
        slot = int(m.group(1))
        name_rest = name[m.end():]
    else:
        m = re.match(r'^student\s+(\d+)\s*-\s*', low)
        if m:
            slot = int(m.group(1))
            name_rest = name[m.end():]
        else:
            name_rest = name

    rest_low = name_rest.lower().strip()

    # Match against targets — first match wins
    for col, labels in TARGETS:
        for lab in labels:
            # Exact-ish substring matches at the START of the name avoid
            # collisions like "Medication Allergy" matching "medications"
            if rest_low.startswith(lab) or rest_low.replace(':', '').strip() == lab:
                return slot, col
    return None, None


def fetch_field_schema(pit, location_id):
    """Returns list of {id, fieldKey, name, dataType}."""
    r = requests.get(
        f'{GHL_BASE}/locations/{location_id}/customFields',
        headers={
            'Authorization': f'Bearer {pit}',
            'Version': GHL_VERSION, 'Accept': 'application/json',
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json().get('customFields', [])


def search_contacts(pit, location_id, tag):
    all_c = []
    page = 1
    while page <= 50:
        r = requests.post(
            f'{GHL_BASE}/contacts/search',
            headers={
                'Authorization': f'Bearer {pit}',
                'Version': GHL_VERSION, 'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            json={
                'locationId': location_id, 'pageLimit': 100, 'page': page,
                'filters': [{'field': 'tags', 'operator': 'contains', 'value': tag}],
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        contacts = data.get('contacts', [])
        all_c.extend(contacts)
        if len(contacts) < 100:
            break
        page += 1
    return all_c


def main():
    args = parse_args()
    env = load_env()

    db_url = env['DATABASE_URL']
    conn = psycopg2.connect(db_url, sslmode='require',
                             cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    cur = conn.cursor()

    # Decrypt Wooster PIT
    cur.execute("""SELECT ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag
                     FROM schools WHERE id = %s""", (WOOSTER_SCHOOL_ID,))
    sr = cur.fetchone()
    pit = decrypt_pit(env, sr['ghl_pit_encrypted'], sr['ghl_pit_iv'], sr['ghl_pit_tag'])
    loc = sr['ghl_location_id']

    # Load Wooster's students + parent contact mapping
    cur.execute("""
        SELECT s.id AS student_id, s.family_id, s.metadata,
               p.ghl_contact_id, p.email, p.first_name AS parent_first, p.last_name AS parent_last,
               s.first_name AS student_first, s.last_name AS student_last
          FROM students s
          JOIN parents p ON p.family_id = s.family_id AND p.is_primary = true
         WHERE s.school_id = %s AND s.status = 'active'
    """, (WOOSTER_SCHOOL_ID,))
    students = cur.fetchall()
    students_by_contact_slot = defaultdict(dict)  # ghl_contact_id -> { slot: student_obj }
    for s in students:
        slot = None
        try: slot = int((s['metadata'] or {}).get('slot'))
        except (TypeError, ValueError): pass
        if slot and s['ghl_contact_id']:
            students_by_contact_slot[s['ghl_contact_id']][slot] = s
    print(f'Wooster students: {len(students)}')
    print(f'GHL contacts with at least one student: {len(students_by_contact_slot)}')

    # Fetch GHL field schema and classify
    print('\nFetching GHL field schema...')
    schema = fetch_field_schema(pit, loc)
    print(f'  {len(schema)} custom fields')

    # field_id -> (slot, target_column)
    field_mapping = {}
    classified_by_target = Counter()
    for f in schema:
        slot, target = classify_field(f.get('name') or '')
        if slot and target:
            field_mapping[f['id']] = (slot, target)
            classified_by_target[(slot, target)] += 1
    print(f'\nClassified {len(field_mapping)} health fields:')
    for (slot, target), n in sorted(classified_by_target.items()):
        print(f'  slot {slot:>1}  {target:<35} {n} field(s)')

    if not args.dry_run:
        confirm = input('\nProceed with WRITES to student_health_profiles? [y/N]: ')
        if confirm.lower() != 'y':
            print('Aborted.')
            return

    # Fetch all enrolled Wooster contacts
    print('\nFetching contacts from GHL...')
    contacts = search_contacts(pit, loc, ENROLLMENT_TAG)
    print(f'  {len(contacts)} contacts')

    # Build the per-student updates
    updates = []  # list of (student_id, dict_of_columns)
    no_match = 0
    fields_seen_per_target = Counter()
    for c in contacts:
        cid = c.get('id')
        student_slots = students_by_contact_slot.get(cid, {})
        if not student_slots:
            no_match += 1
            continue

        # Build per-slot accumulator
        per_slot = defaultdict(dict)  # slot -> { col: value }
        for cf in c.get('customFields', []):
            fid = cf.get('id')
            val = cf.get('value')
            if val is None or val == '' or fid not in field_mapping:
                continue
            slot, target = field_mapping[fid]
            v = str(val).strip()
            if not v:
                continue
            # Prefer first non-empty value if duplicate fields exist for the
            # same (slot, target) — they're duplicates from GHL form clones.
            if target not in per_slot[slot]:
                per_slot[slot][target] = v
                fields_seen_per_target[target] += 1

        for slot, student in student_slots.items():
            data = per_slot.get(slot, {})
            if not data:
                continue
            updates.append((student['student_id'], student, data))

    print(f'\nResolved {len(updates)} per-student health updates')
    print(f'GHL contacts without a matching student family: {no_match}')
    print(f'\nFields populated by target column:')
    for tgt, n in fields_seen_per_target.most_common():
        print(f'  {tgt:<35} {n}')

    # Sample: show 5 representative updates
    print(f'\nSample updates (first 5):')
    for sid, student, data in updates[:5]:
        name = f"{student['student_first']} {student['student_last']}"
        print(f'  {name:<30}  {len(data)} field(s):  {list(data.keys())}')

    if args.dry_run:
        print(f'\n(dry-run mode — no DB writes)')
        return

    # ---- COMMIT ----
    print('\nWriting to student_health_profiles...')
    upserted = 0
    for student_id, student, data in updates:
        cols = list(data.keys())
        placeholders = ', '.join([f'%s' for _ in cols])
        col_list = ', '.join(cols)
        set_clauses = ', '.join([f'{c} = COALESCE(NULLIF(EXCLUDED.{c}, \'\'), student_health_profiles.{c})' for c in cols])
        sql = f"""
            INSERT INTO student_health_profiles
              (school_id, student_id, {col_list}, updated_at)
            VALUES (%s, %s, {placeholders}, now())
            ON CONFLICT (school_id, student_id) DO UPDATE SET
              {set_clauses},
              updated_at = now()
        """
        cur.execute(sql, [WOOSTER_SCHOOL_ID, student_id, *[data[c] for c in cols]])
        upserted += 1

    conn.commit()
    print(f'  upserted {upserted} student health profile rows')

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
