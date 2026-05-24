#!/usr/bin/env python3
"""
Import Wooster's legacy GHL form submissions into the multi-tenant portal.

For each row in the submissions CSV:
  - Identify which form it is (from the URL).
  - Identify the parent (by email).
  - Match to a family in the Wooster family-graph.
  - Extract data into the right shapes:
      family forms  -> portal_form_submissions (one per submission, status='legacy_imported')
                       + family-level fields written to GHL via writeback (later)
      per-student   -> portal_form_submissions (one per submission, scoped to a student
                       slot the importer infers) + student_health_profiles updates
  - Raise migration flags when attribution is ambiguous.

Modes:
  --dry-run   parse + classify + report; do not write to DB. (default)
  --commit    write to DB. Idempotent: if a (family, form, submission_date)
              row already exists from a previous import, skip.

Report:
  Writes a CSV report next to the input file showing what we'd do per row,
  what flags we'd raise, and a summary at the bottom.

Usage:
  python scripts/import-wooster-legacy-submissions.py \
      --csv "C:/Users/thelo/Downloads/5206b9ea-5685-4375-abcc-0eef1d1a3a16.csv" \
      --dry-run
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict, Counter
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a'

# Map: legacy form ID -> (portal form slug, forced_student_slot)
# Wooster created separate GHL forms per student slot (e.g. one Health
# History form for student 1, a clone for student 2, another for student 3).
# Using the form ID gives us deterministic slot attribution.
#   forced_student_slot of None = use inference from CSV row's student name
#   forced_student_slot of 1/2/3/4 = treat every submission as that slot
LEGACY_FORM_MAP = {
    # Family-level (3)
    'ZYkoa8s2oogcuu7FjoLK': ('emergency-medical', None),
    'WQq9S2p4m8W9G2m1P0zb': ('media-permission', None),
    'REM1LBxflMG7n4yhY0Eb': ('ode-connectivity', None),

    # Student slot 1 (5) — original forms; data lives in unprefixed CSV columns
    'UI1uIRAmjurmCYSwUDdp': ('enrollment-agreement', 1),
    'WB996PpkIOHsNA09ujii': ('health-history', 1),
    'Ay7JhvpgynDUY1mFPcZX': ('health-conditions', 1),
    'uA8aMpHrjf73nCMGsxPT': ('medications', 1),
    'r9bL02ZYgQwy4ywqQtN6': ('injury-history', 1),

    # Student slot 2 variants — data lives in "(Student 2) X" CSV columns
    'UBfZeRX7zetvyfDAE4hZ': ('enrollment-agreement', 2),
    'NUKD5cqgosBknProngju': ('health-history', 2),
    'vi9hXBKc8sK5ap84YOiA': ('injury-history', 2),
    'HxF0B8z4DZP80wgygnVn': ('medications', 2),
    # Per-student emergency-medical variants (rare, 4 submissions total).
    # These captured per-student hospital + emergency consent.
    'qpCrmVKktXxc2DjeIYhj': ('emergency-medical', 2),
    'fnfXzXBIJ6IqNBcWVsyu': ('emergency-medical', 2),

    # Student slot 3 variants
    'qtxyUoS6noVx7uT8SKhW': ('enrollment-agreement', 3),
    'pUpngxdf2LmpDMeG2g57': ('health-history', 3),
    'hN1iiv2fyPhhVqmEbQoN': ('injury-history', 3),
    '7snLLIx6p9LZCTpCFeSe': ('medications', 3),
}

# Manually-curated email → family resolutions from the unmatched-email
# resolver script (high/medium confidence matches). Each entry maps a
# secondary/typo email to the primary email of an enrolled family.
ALT_EMAIL_TO_PRIMARY = {
    'moolay@gmail.com': 'amanda.b.good@gmail.com',
    'tabetha3185@gmial.com': 'tabetha3185@gmail.com',
    'magconboys1125@gmail.com': 'andrew398600@gmail.com',
    'dfarah595@gmail.com': 'sherman.1267@gmail.com',
    'rkilgore516@gmail.com': 'kilgore@woomontessori.org',
    'adelenolan82@yajoo.com': 'adelenolan82@yahoo.com',
    'kalina.zutavern@gmail.com': 'kzz6@case.edu',
}

# Per-student form slugs (need student attribution)
PER_STUDENT_SLUGS = {
    'enrollment-agreement', 'health-history', 'health-conditions',
    'medications', 'injury-history',
}

# Family-level form slugs (one-per-family)
FAMILY_SLUGS = {
    'emergency-medical', 'media-permission', 'ode-connectivity',
}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--csv', required=True, help='Path to the submissions CSV')
    p.add_argument('--dry-run', action='store_true', default=True,
                   help='Default. Parse + report only.')
    p.add_argument('--commit', action='store_true',
                   help='Actually write to the DB.')
    args = p.parse_args()
    if args.commit:
        args.dry_run = False
    return args


def get_db_url():
    """Load DATABASE_URL from the dashboards .env.local."""
    env_path = Path(__file__).parent.parent / '.env.local'
    if not env_path.exists():
        print(f'ERROR: {env_path} not found', file=sys.stderr)
        sys.exit(1)
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        if k.strip() == 'DATABASE_URL':
            return v.strip()
    print('ERROR: DATABASE_URL not found in .env.local', file=sys.stderr)
    sys.exit(1)


def form_id_from_url(url):
    m = re.search(r'/form/([A-Za-z0-9]+)', url or '')
    return m.group(1) if m else None


def parse_submission_date(s):
    """Parses GHL's 'May 15th 2026, 8:36 am' format -> ISO."""
    if not s:
        return None
    s = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', s.strip())
    for fmt in ('%B %d %Y, %I:%M %p', '%B %d %Y, %H:%M', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            continue
    return None


def load_families(cur):
    """Return: {email_lower: {family_id, parent_id, ghl_contact_id, students: [{id, slot, name}]}}"""
    cur.execute("""
        SELECT p.id AS parent_id, p.family_id, p.ghl_contact_id,
               LOWER(p.email) AS email,
               p.first_name, p.last_name
          FROM parents p
         WHERE p.school_id = %s AND p.is_primary = true AND p.email IS NOT NULL
    """, (WOOSTER_SCHOOL_ID,))
    parents = cur.fetchall()

    fam_ids = [p['family_id'] for p in parents]
    students_by_family = defaultdict(list)
    if fam_ids:
        cur.execute("""
            SELECT id, family_id, first_name, last_name, metadata
              FROM students
             WHERE school_id = %s AND family_id = ANY(%s::uuid[])
             ORDER BY family_id, (metadata->>'slot')::int NULLS LAST
        """, (WOOSTER_SCHOOL_ID, fam_ids))
        for s in cur.fetchall():
            slot = None
            if s['metadata'] and s['metadata'].get('slot'):
                try:
                    slot = int(s['metadata']['slot'])
                except (TypeError, ValueError):
                    pass
            students_by_family[s['family_id']].append({
                'id': s['id'], 'slot': slot,
                'first_name': s['first_name'], 'last_name': s['last_name'],
                'full_name': f"{s['first_name']} {s['last_name']}".strip(),
            })

    by_email = {}
    for p in parents:
        if not p['email']:
            continue
        by_email[p['email']] = {
            'parent_id': p['parent_id'],
            'family_id': p['family_id'],
            'ghl_contact_id': p['ghl_contact_id'],
            'parent_name': f"{p['first_name']} {p['last_name']}".strip(),
            'students': students_by_family.get(p['family_id'], []),
        }
    return by_email


def load_form_definitions(cur):
    cur.execute("""
        SELECT id, slug, per_student, legacy_completion_field_key
          FROM portal_form_definitions
         WHERE school_id = %s
    """, (WOOSTER_SCHOOL_ID,))
    return {r['slug']: dict(r) for r in cur.fetchall()}


# ---------------------------------------------------------------------------
# Per-form response extractors
# ---------------------------------------------------------------------------

def extract_responses_emergency_medical(row, student_slot=None):
    """Family-level extraction from a CSV row that was submitted to the
    Emergency Medical form. Maps CSV column names to portal-form field keys.
    """
    g = lambda k: (row.get(k) or '').strip()
    return {
        'ec1_name': g('Emergency Contact #1 Name'),
        'ec1_phone': g('Emergency Contact #1 Phone Numbers'),
        'ec1_relationship': g('Emergency Contact 1 Relationship to student'),
        'ec2_name': g('Emergency Contact #2 Name'),
        'ec2_phone': g('Emergency Contact #2 Phone Numbers'),
        'ec2_relationship': g('Emergency Contact 2 Relationship to student'),
        'ec3_name': g('Emergency Contact #3 Name'),
        'ec3_phone': g('Emergency Contact #3 Phone Numbers'),
        'ec3_relationship': g('Emergency Contact 3 Relationship to student'),
        'insurance_company': g('Insurance Company'),
        'insurance_policy': g('Policy Number'),
        'insurance_holder': g("Policy Holder's Name"),
        'doctor_name': g('Doctor Name'),
        'doctor_phone': g('Doctor Phone'),
        'dentist_name': g('Dentist Name'),
        'dentist_phone': g('Dentist Phone'),
        'specialist_name': g('Medical Specialist Name'),
        'specialist_phone': g('Medical Specialist Phone'),
        'hospital_name': g('Hospital Name'),
        'hospital_phone': g('Hospital Phone'),
        'emergency_consent': 'grant' if 'grant' in g(
            'In the event of an emergency, please indicate whether you grant or refuse to grant consent for treatment for your child'
        ).lower() else ('refuse' if 'refuse' in g(
            'In the event of an emergency, please indicate whether you grant or refuse to grant consent for treatment for your child'
        ).lower() else ''),
        'existing_conditions': g('Existing Medical Conditions'),
        'current_medications': g('Medications'),
        'allergies': g('Allergies'),
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_media_permission(row, student_slot=None):
    g = lambda k: (row.get(k) or '').strip()
    # The CSV doesn't have an explicit "grant" flag column for media — assume
    # submission of the form implies grant unless we find a discriminator.
    return {
        'media_grant': 'yes',
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_ode_connectivity(row, student_slot=None):
    g = lambda k: (row.get(k) or '').strip()
    internet = g('Do you have Internet connectivity in your home?')
    device = g('What type of device do you have available in your home for remote learning?')
    return {
        'internet_connectivity': (
            'broadband' if 'broadband' in internet.lower() else
            'mobile' if 'mobile' in internet.lower() or 'hotspot' in internet.lower() else
            'none' if internet else ''
        ),
        'device_type': (
            'computer' if 'laptop' in device.lower() or 'desktop' in device.lower() or 'tablet' in device.lower() else
            'phone_only' if 'phone' in device.lower() or 'smartphone' in device.lower() else
            'none' if device else ''
        ),
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_enrollment_agreement(row, student_slot=1):
    g = lambda k: (row.get(k) or '').strip()
    # Slot-aware column picker
    def slot_col(base_col):
        if student_slot == 1:
            return base_col
        # CSV uses "(Student 2) base", "(Student 3) base", "(Student 4) base "
        # (note: some columns have trailing spaces — we strip on access)
        return f'(Student {student_slot}) {base_col}'

    plan_text = g(slot_col('The Parent(s) agree to pay the above tuition (minus the $300 deposit) using the following plan:'))
    # Best-effort mapping
    pt = plan_text.lower()
    mapped = (
        'annual' if 'annual' in pt or 'single' in pt else
        'biannual' if '2 equal' in pt or 'semi' in pt else
        'quarterly' if 'quarter' in pt else
        'monthly_9' if '9 monthly' in pt or '9-month' in pt else
        'monthly_10' if '10 monthly' in pt or '10-month' in pt else
        'ed_choice' if 'ed choice' in pt or 'edchoice' in pt or 'scholarship' in pt else
        'other' if plan_text else ''
    )
    return {
        'student_full_name': '',  # filled by caller from student record
        'payment_plan': mapped,
        'plan_exceptions': g('Please list any exceptions to the above:'),
        'agree_terms': 'true',     # implicit on submission
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_health_history(row, student_slot=1):
    g = lambda k: (row.get(k) or '').strip()
    if student_slot == 1:
        return {
            'incomplete_history_reason': g('If you do NOT have a complete medical history for this student, please explain why: (But still complete the following forms to the best of your ability.)'),
            'birth_developmental': g('Birth & Developmental History'),
            'special_needs': g('Special Needs or Disability'),
            'parent_signature': g('Parent/Guardian Signature'),
        }
    return {
        'incomplete_history_reason': g(f'(Student {student_slot}) If you do NOT have a complete medical history for this student, please explain why: (But still complete the following forms to the best of your ability.)'),
        'birth_developmental': g(f'(Student {student_slot}) Birth & Developmental History'),
        'special_needs': g(f'(Student {student_slot}) Special Needs or Disability'),
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_health_conditions(row, student_slot=1):
    g = lambda k: (row.get(k) or '').strip()
    if student_slot == 1:
        prefix = ''
    else:
        prefix = f'Student {student_slot} - '
    yn = lambda v: 'yes' if v.lower() == 'yes' else ('no' if v.lower() == 'no' else '')
    fields = [
        ('add_adhd', f'{prefix}ADD/ADHD'),
        ('allergy_insect', f'{prefix}Severe Stinging Insect Allergies (If local allergy/reaction only, just note in allergy list below)'),
        ('allergy_food', f'{prefix}Food Allergies'),
        ('allergy_pollen', f'{prefix}Pollen Allergy'),
        ('allergy_latex', f'{prefix}Latex Allergy'),
        ('allergy_medication', f'{prefix}Medication Allergy'),
        ('has_anaphylaxis', f'{prefix}Has Anaphylaxis Reaction (Breathing Difficulties)'),
        ('has_epipen', f'{prefix}Has Epipen'),
        ('allergies_list', f'{prefix}Include all Medicines, Foods, Stinging Insects, Plant, Animal, Environmental, etc.'),
        ('asthma', f'{prefix}Asthma:'),
        ('diabetes', f'{prefix}Diabetes:'),
        ('seizures', f'{prefix}Seizures/Epilepsy:'),
        ('vision_problems', f'{prefix}Vision Problems:'),
        ('wears_glasses', f'{prefix}Wears Glasses or Contacts:'),
        ('hearing_problems', f'{prefix}Hearing Problems:'),
        ('ear_infections', f'{prefix}Ear Infections (frequently after age 3):'),
        ('heart_condition', f'{prefix}Heart Condition:'),
        ('kidney_disease', f'{prefix}Kidney Disease:'),
        ('enlarged_spleen', f'{prefix}Enlarged Spleen:'),
        ('bladder_problems', f'{prefix}Bladder Problems:'),
        ('bowel_problems', f'{prefix}Bowel Problems:'),
        ('missing_organs', f'{prefix}Missing/Malfunctioning Organs (kidney, eye, testicle (males), spleen, etc.)'),
        ('cystic_fibrosis', f'{prefix}Cystic Fibrosis:'),
        ('osteopenia', f'{prefix}Osteopenia or Osteoporosis:'),
        ('spinal_issues', f'{prefix}Spinal Issues (scoliosis, etc.):'),
        ('spina_bifida', f'{prefix}Spina Bifida:'),
        ('muscle_spasticity', f'{prefix}Muscle Spasticity:'),
        ('numbness', f'{prefix}Numbness (arms, hands, legs, or feet):'),
        ('weakness', f'{prefix}Weakness (arms, hands, legs, or feet):'),
        ('blood_disorder', f'{prefix}Blood Disorder:'),
        ('hepatitis', f'{prefix}Hepatitis:'),
        ('tics', f'{prefix}Tics/Nervous Twitches:'),
        ('emotional_behavioral', f'{prefix}Emotional/Behavioral Concerns:'),
        ('other_health_info', f"{prefix}Please list any other health information, questions, or concerns relevant to your child's safety."),
    ]
    out = {}
    for portal_key, csv_col in fields:
        # Try exact, then with trailing-space variants the CSV occasionally has
        v = (row.get(csv_col) or row.get(csv_col + ' ') or '').strip()
        if portal_key.endswith('_list') or portal_key == 'other_health_info':
            out[portal_key] = v
        else:
            out[portal_key] = yn(v)
    out['parent_signature'] = g('Parent/Guardian Signature')
    return out


def extract_responses_medications(row, student_slot=1):
    g = lambda k: (row.get(k) or '').strip()
    if student_slot == 1:
        return {
            'medications_list': g('Medications'),
            'medical_admin_form_url': g('Upload Medical Administration Form'),
            'parent_signature': g('Parent/Guardian Signature'),
        }
    return {
        'medications_list': g(f'(Student {student_slot}) Medications'),
        'medical_admin_form_url': g(f'(Student {student_slot}) Upload Medical Administration'),
        'parent_signature': g('Parent/Guardian Signature'),
    }


def extract_responses_injury_history(row, student_slot=1):
    g = lambda k: (row.get(k) or '').strip()
    if student_slot == 1:
        return {
            'participation_restricted': (g("Has a provider ever denied or restricted your child's participation in sports/activities for any reason?") or '').lower(),
            'had_surgery': (g('Has your child ever had surgery or serious injury?') or '').lower(),
            'spent_night_in_hospital': (g('Has your child ever spent the night in the hospital?') or '').lower(),
            'injury_list': g('Please list ALL injuries and illnesses that have required medical attention (include years, if appropriate):'),
            'parent_signature': g('Parent/Guardian Signature'),
        }
    return {
        'participation_restricted': (g(f"(Student {student_slot}) Has a provider ever denied or restricted your child's participation in sports/activities for any reason?") or '').lower(),
        'had_surgery': (g(f'(Student {student_slot}) Has your child ever had surgery or serious injury?')
                        or g(f'(Student {student_slot}) Has your child ever had surgery or serious injury? (copy)') or '').lower(),
        'spent_night_in_hospital': (g(f'(Student {student_slot}) Has your child ever spent the night in the hospital?') or '').lower(),
        'injury_list': g(f'(Student {student_slot}) Please list ALL injuries and illnesses that have required medical attention (include years, if appropriate)'),
        'parent_signature': g('Parent/Guardian Signature'),
    }


EXTRACTORS = {
    'emergency-medical': extract_responses_emergency_medical,
    'media-permission': extract_responses_media_permission,
    'ode-connectivity': extract_responses_ode_connectivity,
    'enrollment-agreement': extract_responses_enrollment_agreement,
    'health-history': extract_responses_health_history,
    'health-conditions': extract_responses_health_conditions,
    'medications': extract_responses_medications,
    'injury-history': extract_responses_injury_history,
}


# ---------------------------------------------------------------------------
# Student attribution for per-student forms
# ---------------------------------------------------------------------------

def infer_student_slot(row, form_slug, students):
    """
    For a per-student form submission, figure out which student in the family
    it belongs to.

    Returns a tuple: (student_obj_or_None, slot_or_None, attribution_method).
    attribution_method is one of:
      'student_name_field'   — row had Student First Name that matched
      'slot_2_data_present'  — row only had (Student 2) data populated
      'slot_3_data_present', 'slot_4_data_present'
      'only_student'         — family has exactly 1 student
      'unknown'              — couldn't tell
    """
    # 1) Try matching by Student First Name in the row
    sn = (row.get('Student First Name') or '').strip()
    sl = (row.get('Student Last Name') or '').strip()
    if sn:
        for s in students:
            if s['first_name'].lower() == sn.lower():
                return s, s['slot'] or 1, 'student_name_field'
        # Name didn't match anyone — still treat as slot 1 attempt but flag
        if students:
            return students[0], 1, 'student_name_field_no_match'

    # 2) Check if (Student 2/3/4) columns are populated
    for slot in (2, 3, 4):
        # Look for any column that starts with "(Student N)" or "Student N -"
        # and is populated; if so, this submission was attempted as that slot
        has_slot_data = any(
            (row.get(k) or '').strip()
            for k in row.keys()
            if (k.startswith(f'(Student {slot})') or k.startswith(f'Student {slot} -'))
        )
        if has_slot_data:
            # Find the matching student by slot
            for s in students:
                if s['slot'] == slot:
                    return s, slot, f'slot_{slot}_data_present'
            # Slot data present but no student at that slot in family-graph
            return None, slot, f'slot_{slot}_data_present_no_student'

    # 3) Single-student family
    if len(students) == 1:
        return students[0], 1, 'only_student'

    # 4) Couldn't tell
    return None, None, 'unknown'


# ---------------------------------------------------------------------------
# Flag detection
# ---------------------------------------------------------------------------

def detect_flags(family, family_submissions_by_form, forms_meta):
    """
    Given a family and their submissions grouped by form_slug,
    raise migration flags as needed.

    Returns a list of flag dicts.
    """
    flags = []
    students = family['students']
    student_count = len(students)

    # 1) Family has 2+ kids and emergency-medical was submitted.
    #    Emergency contacts were captured family-wide, not per-student.
    #    Raise ONE flag PER STUDENT so the per-student "Same / Different"
    #    widget can resolve them one child at a time inside per-student forms.
    if student_count >= 2 and 'emergency-medical' in family_submissions_by_form:
        for s in students:
            flags.append({
                'kind': 'emergency_contacts_per_student_review',
                'student_id': s['id'],
                'form_slug': None,   # form-agnostic — surfaces on any per-student form
                'message': (
                    f"Your emergency contacts for {s['full_name']} were entered before "
                    f"per-student capture. Please confirm the same contacts apply, or "
                    f"enter different ones."
                ),
                'payload': {'student_count': student_count, 'student_name': s['full_name']},
            })

    # 2) Per-student form: only some students have submissions
    for slug in PER_STUDENT_SLUGS:
        if slug not in family_submissions_by_form:
            continue
        subs = family_submissions_by_form[slug]
        covered_student_ids = set(s['_student_id'] for s in subs if s['_student_id'])
        uncovered = [s for s in students if s['id'] not in covered_student_ids]
        if uncovered and student_count >= 2:
            for s in uncovered:
                flags.append({
                    'kind': 'missing_submission_for_student',
                    'student_id': s['id'],
                    'form_slug': slug,
                    'message': f"This form needs to be completed for {s['full_name']}.",
                    'payload': {
                        'student_name': s['full_name'],
                        'covered_student_ids': list(covered_student_ids),
                    },
                })

    # 3) Per-student submission with unknown attribution
    for slug, subs in family_submissions_by_form.items():
        if slug not in PER_STUDENT_SLUGS:
            continue
        for s in subs:
            if s.get('_attribution') in ('unknown', 'student_name_field_no_match',
                                          'slot_2_data_present_no_student',
                                          'slot_3_data_present_no_student',
                                          'slot_4_data_present_no_student'):
                flags.append({
                    'kind': 'student_attribution_unknown',
                    'student_id': None,
                    'form_slug': slug,
                    'message': (
                        f'We have a {slug} submission on file but could not tell '
                        f'which child it was for (attribution method: {s.get("_attribution")}). '
                        f'Please review and confirm.'
                    ),
                    'payload': {
                        'submission_date': s.get('_submitted_at'),
                        'attribution': s.get('_attribution'),
                    },
                })

    # 4) Multiple submissions for the same per-student form from same family
    #    → possible data collision
    for slug, subs in family_submissions_by_form.items():
        if slug not in PER_STUDENT_SLUGS:
            continue
        # Group submissions by student_id
        by_student = defaultdict(list)
        unassigned = []
        for s in subs:
            if s['_student_id']:
                by_student[s['_student_id']].append(s)
            else:
                unassigned.append(s)
        for sid, slist in by_student.items():
            if len(slist) > 1:
                student = next((s for s in students if s['id'] == sid), None)
                if student:
                    flags.append({
                        'kind': 'possible_student_data_collision',
                        'student_id': sid,
                        'form_slug': slug,
                        'message': (
                            f'There are {len(slist)} submissions of this form for '
                            f'{student["full_name"]}. The earlier answers may have been '
                            f'overwritten. Please review and re-submit if needed.'
                        ),
                        'payload': {'submission_count': len(slist)},
                    })

    return flags


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f'ERROR: {csv_path} not found', file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(get_db_url(), sslmode='require',
                            cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    cur = conn.cursor()

    print('Loading Wooster family-graph...')
    families = load_families(cur)
    print(f'  found {len(families)} parent records with email')

    print('Loading Wooster portal-form definitions...')
    forms_meta = load_form_definitions(cur)
    print(f'  found {len(forms_meta)} portal-form definitions')

    print(f'\nReading CSV: {csv_path}')
    rows = []
    with csv_path.open(encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            rows.append(row)
    print(f'  {len(rows)} total rows')

    # Group all submissions by family
    family_subs = defaultdict(lambda: defaultdict(list))   # family_id -> form_slug -> [submission dicts]
    unmatched_emails = Counter()
    unknown_forms = Counter()
    rows_per_form = Counter()
    students_attribution_counter = Counter()

    alt_email_uses = Counter()
    for r in rows:
        url = r.get('URL', '')
        fid = form_id_from_url(url)
        if not fid:
            unknown_forms['(no URL)'] += 1
            continue
        mapping = LEGACY_FORM_MAP.get(fid)
        if not mapping:
            unknown_forms[fid] += 1
            continue
        slug, forced_slot = mapping
        rows_per_form[slug] += 1

        email_raw = (r.get('Email') or '').strip().lower()
        if not email_raw:
            unmatched_emails['(blank email)'] += 1
            continue

        # Apply alternate-email resolution: parent submitted from a typo'd
        # or secondary email, but we know their primary family.
        email_for_lookup = ALT_EMAIL_TO_PRIMARY.get(email_raw, email_raw)
        if email_for_lookup != email_raw:
            alt_email_uses[email_raw] += 1

        fam = families.get(email_for_lookup)
        if not fam:
            unmatched_emails[email_raw] += 1
            continue

        submitted_at = parse_submission_date(r.get('Submission Date', ''))

        if slug in PER_STUDENT_SLUGS:
            # If form ID forces a slot, use it. Otherwise infer.
            if forced_slot is not None:
                # Find the student at that slot in the family
                student = next((s for s in fam['students'] if s['slot'] == forced_slot), None)
                slot = forced_slot
                method = f'form_id_slot_{forced_slot}'
                if not student:
                    method = f'form_id_slot_{forced_slot}_no_student'
            else:
                student, slot, method = infer_student_slot(r, slug, fam['students'])

            students_attribution_counter[method] += 1
            extractor = EXTRACTORS[slug]
            responses = extractor(r, student_slot=slot or 1)
            if student:
                responses['student_full_name'] = student['full_name']
            family_subs[fam['family_id']][slug].append({
                'email': email_raw,
                '_email_resolved_to': email_for_lookup if email_for_lookup != email_raw else None,
                '_student_id': student['id'] if student else None,
                '_student_slot': slot,
                '_attribution': method,
                '_submitted_at': submitted_at,
                '_responses': responses,
            })
        else:
            extractor = EXTRACTORS[slug]
            responses = extractor(r)
            # If the family-level form was the per-student-2 emergency variant,
            # extract its student-2 fields and treat as supplementary student data.
            family_subs[fam['family_id']][slug].append({
                'email': email_raw,
                '_email_resolved_to': email_for_lookup if email_for_lookup != email_raw else None,
                '_student_id': None,
                '_emergency_medical_slot': forced_slot,
                '_submitted_at': submitted_at,
                '_responses': responses,
            })

    # Detect flags per family
    print('\nDetecting migration flags...')
    all_flags = []
    family_flag_counts = Counter()
    for family_id, by_form in family_subs.items():
        # find a family obj
        fam = next((f for f in families.values() if f['family_id'] == family_id), None)
        if not fam: continue
        flags = detect_flags(fam, by_form, forms_meta)
        for fl in flags:
            fl['family_id'] = family_id
            fl['parent_email'] = next(iter(by_form.values()))[0]['email']
            all_flags.append(fl)
            family_flag_counts[family_id] += 1

    # Compute totals
    total_submissions = sum(len(s) for byform in family_subs.values() for s in byform.values())
    families_with_any_submission = len(family_subs)
    alt_emails_resolved = sum(alt_email_uses.values())

    # ---- REPORT ----
    print('\n' + '=' * 72)
    print('DRY-RUN SUMMARY' if args.dry_run else 'COMMIT SUMMARY')
    print('=' * 72)
    print(f'Total CSV rows:                  {len(rows)}')
    print(f'Rows with recognized form URLs:  {sum(rows_per_form.values())}')
    print(f'Rows with unknown form IDs:      {sum(unknown_forms.values())}')
    if unknown_forms:
        for f, n in unknown_forms.most_common(5):
            print(f'                                 {n:>4}  {f}')
    print()
    print(f'Submissions per form:')
    for slug, n in rows_per_form.most_common():
        print(f'  {slug:<25} {n}')
    print()
    if alt_emails_resolved:
        print(f'\nAlt-email auto-resolutions:      {alt_emails_resolved} submissions across {len(alt_email_uses)} emails')
        for e, n in alt_email_uses.most_common():
            print(f'  {n:>3}  {e:<40} -> {ALT_EMAIL_TO_PRIMARY[e]}')
        print()
    print(f'Rows with no email on file:      {unmatched_emails.get("(blank email)", 0)}')
    matched_emails = [e for e in unmatched_emails if e != '(blank email)']
    print(f'Unmatched parent emails:         {sum(unmatched_emails[e] for e in matched_emails)}')
    if matched_emails:
        print('  (top 5)')
        for e in sorted(matched_emails, key=lambda x: -unmatched_emails[x])[:5]:
            print(f'    {unmatched_emails[e]:>3}  {e}')
    print()
    print(f'Per-student attribution method counts:')
    for method, n in students_attribution_counter.most_common():
        print(f'  {method:<35} {n}')
    print()
    print(f'Families with at least one submission:  {families_with_any_submission}')
    print(f'Total submissions to import:            {total_submissions}')
    print(f'Total migration flags raised:           {len(all_flags)}')
    flag_kind_counts = Counter(f['kind'] for f in all_flags)
    for kind, n in flag_kind_counts.most_common():
        print(f'  {kind:<45} {n}')
    print()
    print(f'Families with flags:                    {len(family_flag_counts)}')

    # Write detailed CSV report
    report_path = csv_path.parent / (csv_path.stem + '_import_report.csv')
    with report_path.open('w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['family_id', 'parent_email', 'flag_kind', 'student_id',
                    'form_slug', 'message', 'payload'])
        for fl in all_flags:
            w.writerow([
                fl['family_id'], fl.get('parent_email', ''), fl['kind'],
                fl.get('student_id', ''), fl.get('form_slug', ''),
                fl['message'], json.dumps(fl.get('payload', {})),
            ])
    print(f'\nFlag report written to: {report_path}')

    if args.dry_run:
        print('\n(dry-run mode — no changes written to DB)')
        cur.close()
        conn.close()
        return

    # ---- COMMIT MODE ----
    print('\nWriting to DB...')
    inserted = 0
    flags_inserted = 0
    for family_id, by_form in family_subs.items():
        fam = next((f for f in families.values() if f['family_id'] == family_id), None)
        if not fam: continue

        for slug, subs in by_form.items():
            form_meta = forms_meta.get(slug)
            if not form_meta:
                continue
            for s in subs:
                # Idempotency: skip if we already have a legacy_imported row
                # for this (family, form, submitted_at)
                cur.execute("""
                    SELECT id FROM portal_form_submissions
                     WHERE school_id = %s AND family_id = %s
                       AND form_definition_id = %s
                       AND legacy_source = 'wooster_csv_v1'
                       AND submitted_at = %s
                       AND (student_id = %s::uuid OR (student_id IS NULL AND %s::uuid IS NULL))
                """, (
                    WOOSTER_SCHOOL_ID, family_id, form_meta['id'],
                    s['_submitted_at'] or '2025-01-01',
                    s['_student_id'], s['_student_id'],
                ))
                if cur.fetchone():
                    continue

                cur.execute("""
                    INSERT INTO portal_form_submissions
                      (school_id, form_definition_id, family_id, parent_id, student_id,
                       academic_year, responses, status, submitted_at, legacy_source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb,
                            'legacy_imported', %s, 'wooster_csv_v1')
                """, (
                    WOOSTER_SCHOOL_ID, form_meta['id'], family_id,
                    fam['parent_id'], s['_student_id'],
                    '2026-27', json.dumps(s['_responses']),
                    s['_submitted_at'] or '2025-01-01',
                ))
                inserted += 1

        # Insert flags for this family
        flags_for_family = [f for f in all_flags if f['family_id'] == family_id]
        for fl in flags_for_family:
            form_id = None
            if fl.get('form_slug') and fl['form_slug'] in forms_meta:
                form_id = forms_meta[fl['form_slug']]['id']
            cur.execute("""
                INSERT INTO portal_migration_flags
                  (school_id, family_id, student_id, form_definition_id,
                   flag_kind, flag_message, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
            """, (
                WOOSTER_SCHOOL_ID, family_id, fl.get('student_id'),
                form_id, fl['kind'], fl['message'],
                json.dumps(fl.get('payload', {})),
            ))
            flags_inserted += 1

    conn.commit()
    print(f'  inserted {inserted} legacy submissions')
    print(f'  inserted {flags_inserted} migration flags')
    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
