#!/usr/bin/env python3
"""
Try to resolve unmatched parent emails in the Wooster legacy submissions CSV.

Strategy: a parent who submitted forms but isn't in the "enrolled - 26/27"
contact tag is probably one of:
  1. A second parent in a household whose primary parent IS enrolled
     (Parent 2 — they submitted the form themselves using their own email)
  2. The same primary parent using a different email address
  3. An alternate / typo'd email of an existing parent
  4. Genuinely not an enrolled family (withdrawn, prospect, test)

For each unmatched email, we collect every student name they entered across
all their submissions, then look for a Wooster family whose enrolled students'
names overlap. The family with the highest overlap is the likely match.

Output: a CSV report sorted by confidence with one row per unmatched email,
showing the suggested family + match reason.
"""

import csv
import re
import sys
from collections import defaultdict, Counter
from pathlib import Path

import psycopg2
import psycopg2.extras

WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a'

CSV_PATH = Path(r'C:\Users\thelo\Downloads\5206b9ea-5685-4375-abcc-0eef1d1a3a16.csv')


def get_db_url():
    env_path = Path(__file__).parent.parent / '.env.local'
    for line in env_path.read_text(encoding='utf-8').splitlines():
        if line.startswith('DATABASE_URL='):
            return line.split('=', 1)[1].strip()
    raise RuntimeError('DATABASE_URL not found')


def norm_name(s):
    return re.sub(r'[^a-z]', '', (s or '').lower().strip())


def main():
    conn = psycopg2.connect(get_db_url(), sslmode='require',
                            cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()

    # Load all enrolled Wooster parents
    cur.execute("""
        SELECT p.id AS parent_id, p.family_id, LOWER(p.email) AS email,
               p.first_name, p.last_name
          FROM parents p
         WHERE p.school_id = %s AND p.email IS NOT NULL
    """, (WOOSTER_SCHOOL_ID,))
    parents = list(cur.fetchall())
    enrolled_emails = {p['email'] for p in parents}
    parent_by_email = {p['email']: p for p in parents}

    # Load students per family — track by normalized first+last
    cur.execute("""
        SELECT family_id, first_name, last_name
          FROM students
         WHERE school_id = %s AND status = 'active'
    """, (WOOSTER_SCHOOL_ID,))
    family_students = defaultdict(set)   # family_id -> set of (first, last) normalized
    family_first_only = defaultdict(set)
    for s in cur.fetchall():
        first = norm_name(s['first_name'])
        last = norm_name(s['last_name'])
        family_students[s['family_id']].add((first, last))
        family_first_only[s['family_id']].add(first)

    # Also: family display name (for the report)
    cur.execute("""
        SELECT f.id AS family_id, f.display_name,
               COALESCE(string_agg(DISTINCT s.first_name, ', '), '') AS student_names,
               COALESCE(MAX(p.email), '') AS primary_email
          FROM families f
          LEFT JOIN students s ON s.family_id = f.id AND s.status = 'active'
          LEFT JOIN parents p ON p.family_id = f.id AND p.is_primary = true
         WHERE f.school_id = %s
         GROUP BY f.id, f.display_name
    """, (WOOSTER_SCHOOL_ID,))
    family_meta = {r['family_id']: dict(r) for r in cur.fetchall()}

    # Read the CSV, build per-email view: emails -> list of (student names mentioned, parent name)
    unmatched_data = defaultdict(lambda: {
        'first_names': [],   # all the first names this email entered as parent
        'last_names': [],
        'student_pairs': set(),  # set of (first_norm, last_norm) student names
        'student_firsts_only': set(),
        'submission_count': 0,
        'sample_form_url': None,
    })

    student_cols = [
        ('Student First Name', 'Student Last Name'),
        ('Student 2 First Name', 'Student 2 Last Name'),
        ('Student 3 First Name', 'Student 3 Last Name'),
        ('Student 4 First Name', 'Student 4 Last Name'),
    ]

    with CSV_PATH.open(encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            email = (row.get('Email') or '').strip().lower()
            if not email or email in enrolled_emails:
                continue
            d = unmatched_data[email]
            d['submission_count'] += 1
            d['first_names'].append((row.get('First Name') or '').strip())
            d['last_names'].append((row.get('Last Name') or '').strip())
            d['sample_form_url'] = row.get('URL', '')
            for first_col, last_col in student_cols:
                f1 = norm_name(row.get(first_col, ''))
                l1 = norm_name(row.get(last_col, ''))
                if f1:
                    d['student_firsts_only'].add(f1)
                    if l1:
                        d['student_pairs'].add((f1, l1))

    print(f'Unmatched emails: {len(unmatched_data)}')
    print(f'Enrolled Wooster families: {len(family_students)}')
    print()

    # For each unmatched email, find best-matching family
    suggestions = []
    for email, d in unmatched_data.items():
        if not d['student_pairs'] and not d['student_firsts_only']:
            suggestions.append({
                'email': email, 'family_id': None, 'confidence': 'none',
                'reason': 'No student names in any submission',
                'submission_count': d['submission_count'],
                'parent_name': f"{Counter(d['first_names']).most_common(1)[0][0]} {Counter(d['last_names']).most_common(1)[0][0]}".strip(),
                'students_mentioned': '',
                'family_display_name': '',
                'matched_students': '',
                'family_primary_email': '',
            })
            continue

        # Rank families by overlap
        scores = []
        for family_id, students in family_students.items():
            full_match = len(d['student_pairs'] & students)
            first_only = len(d['student_firsts_only'] & family_first_only[family_id])
            if full_match == 0 and first_only == 0:
                continue
            # Score: prefer full-name matches; first-only is weaker
            scores.append((family_id, full_match * 10 + first_only, full_match, first_only))

        scores.sort(key=lambda x: -x[1])
        students_mentioned_str = ', '.join(
            sorted([' '.join(p).strip() for p in d['student_pairs']])
            or sorted(d['student_firsts_only'])
        )
        parent_name = ''
        if d['first_names']:
            parent_name = f"{Counter(d['first_names']).most_common(1)[0][0]} {Counter(d['last_names']).most_common(1)[0][0]}".strip()

        if not scores:
            suggestions.append({
                'email': email, 'family_id': None, 'confidence': 'no_match',
                'reason': f"Student names ({students_mentioned_str}) didn't match any family",
                'submission_count': d['submission_count'],
                'parent_name': parent_name,
                'students_mentioned': students_mentioned_str,
                'family_display_name': '',
                'matched_students': '',
                'family_primary_email': '',
            })
            continue

        best_family_id, score, full_match, first_only = scores[0]
        family = family_meta.get(best_family_id, {})

        # Confidence band
        if full_match >= 1 and len(d['student_pairs']) > 0:
            # Full first+last match
            if full_match == len(d['student_pairs']):
                confidence = 'high'
                reason = f'All {full_match} student name(s) match this family exactly'
            else:
                confidence = 'medium'
                reason = f'{full_match} of {len(d["student_pairs"])} student names match exactly'
        elif first_only >= 1:
            confidence = 'low'
            reason = f'{first_only} first-name(s) overlap (different or missing last name)'
        else:
            confidence = 'no_match'
            reason = 'No overlap'

        matched_students = []
        for fn, ln in d['student_pairs']:
            if (fn, ln) in family_students[best_family_id]:
                matched_students.append(f'{fn} {ln}')
        for fn in d['student_firsts_only']:
            if fn in family_first_only[best_family_id] and not any(fn == p[0] for p in d['student_pairs']):
                matched_students.append(f'{fn} (first-only)')

        suggestions.append({
            'email': email,
            'family_id': best_family_id,
            'confidence': confidence,
            'reason': reason,
            'submission_count': d['submission_count'],
            'parent_name': parent_name,
            'students_mentioned': students_mentioned_str,
            'family_display_name': family.get('display_name', ''),
            'matched_students': ', '.join(matched_students),
            'family_primary_email': family.get('primary_email', ''),
        })

    # Sort by confidence then submission_count
    rank = {'high': 0, 'medium': 1, 'low': 2, 'no_match': 3, 'none': 4}
    suggestions.sort(key=lambda s: (rank.get(s['confidence'], 99), -s['submission_count']))

    # Print summary
    by_conf = Counter(s['confidence'] for s in suggestions)
    print('=' * 72)
    print('UNMATCHED EMAIL RESOLUTION SUMMARY')
    print('=' * 72)
    for level in ('high', 'medium', 'low', 'no_match', 'none'):
        if by_conf[level]:
            n_subs = sum(s['submission_count'] for s in suggestions if s['confidence'] == level)
            print(f'  {level:<10} {by_conf[level]:>3} emails  ({n_subs:>3} submissions)')
    print()

    # Print top 10 high-confidence suggestions
    high_confs = [s for s in suggestions if s['confidence'] in ('high', 'medium')]
    if high_confs:
        print('Top high/medium confidence matches:')
        for s in high_confs[:20]:
            print(f'  [{s["confidence"]:<6}] {s["email"]:<40} ({s["submission_count"]} subs) -> {s["family_display_name"]} ({s["family_primary_email"]})')
            print(f'           matched students: {s["matched_students"]}')

    print()
    # Print no-match list
    no_matches = [s for s in suggestions if s['confidence'] in ('no_match', 'none')]
    if no_matches:
        print(f'No-match emails ({len(no_matches)}):')
        for s in no_matches[:10]:
            print(f'  {s["email"]:<40} ({s["submission_count"]} subs) — parent: {s["parent_name"]} — students mentioned: {s["students_mentioned"]}')

    # Write CSV report
    out_path = CSV_PATH.parent / (CSV_PATH.stem + '_unmatched_resolution.csv')
    with out_path.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=[
            'email', 'parent_name', 'submission_count', 'confidence', 'reason',
            'students_mentioned', 'family_id', 'family_display_name',
            'family_primary_email', 'matched_students',
        ])
        w.writeheader()
        for s in suggestions:
            w.writerow(s)
    print()
    print(f'Full report written to: {out_path}')

    cur.close()
    conn.close()


if __name__ == '__main__':
    main()
