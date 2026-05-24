"""
Reshapes a "one row per student" enrollment CSV into the Growth Suite
import format (one row per family, with student1_*, student2_*, etc.).

USAGE:
  python scripts/reshape-enrollment-csv.py <input.csv> <school_name>

OUTPUTS (alongside the input):
  <input>__families.csv          — one row per family, ready to import
  <input>__needs-review.csv      — rows with missing critical data

Family grouping heuristic: same Guardian #1 email (case-insensitive) =
same family. Falls back to phone number when email is missing. Detects
and auto-corrects swapped email/phone cells.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

# ─── Config ───────────────────────────────────────────────────────────

MAX_STUDENTS_PER_FAMILY = 3   # widens to 3 just in case; usually 1-2
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PHONE_RE = re.compile(r'^[\d\s\-\(\).+]+$')

GRADE_FROM_COLUMN = {
    'Young Community': 'young_community',
    'Primary': 'primary',
    'Kindergarten': 'kindergarten',
}

# ─── Helpers ──────────────────────────────────────────────────────────

def clean(v: str | None) -> str:
    return (v or '').strip()

def looks_like_email(v: str) -> bool:
    return bool(EMAIL_RE.match(v))

def looks_like_phone(v: str) -> bool:
    # at least 7 digits + only typical phone chars
    digits = sum(c.isdigit() for c in v)
    return digits >= 7 and bool(PHONE_RE.match(v))

def fix_swapped(email_cell: str, phone_cell: str) -> tuple[str, str]:
    """If the email column actually contains a phone and vice versa,
    swap them. Otherwise pass through."""
    if looks_like_phone(email_cell) and looks_like_email(phone_cell):
        return phone_cell, email_cell
    return email_cell, phone_cell

def split_full_name(full: str) -> tuple[str, str]:
    """Naive first/last split. Handles 'First Last', 'First Middle Last',
    'Last, First'. Returns (first, last)."""
    full = clean(full)
    if not full:
        return ('', '')
    if ',' in full:
        last, _, first = full.partition(',')
        return (clean(first), clean(last))
    parts = full.split()
    if len(parts) == 1:
        return (parts[0], '')
    return (parts[0], ' '.join(parts[1:]))

def split_student_name(name_cell: str) -> tuple[str, str]:
    """The 'Name' column uses 'Last, First' format."""
    if ',' in name_cell:
        last, _, first = name_cell.partition(',')
        return (clean(first), clean(last))
    # Fallback: assume 'First Last'
    return split_full_name(name_cell)

def parse_birthday(v: str) -> str:
    """Accepts 'October 3, 2022' or '1/13/2025' or similar. Returns
    YYYY-MM-DD or empty string."""
    v = clean(v)
    if not v:
        return ''
    fmts = [
        '%B %d, %Y',        # October 3, 2022
        '%b %d, %Y',        # Oct 3, 2022
        '%m/%d/%Y',         # 1/13/2025
        '%m/%d/%y',         # 1/13/25
        '%Y-%m-%d',
    ]
    for fmt in fmts:
        try:
            return datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            continue
    return ''  # could not parse — caller can flag

def derive_grade(row: dict) -> str:
    for col, label in GRADE_FROM_COLUMN.items():
        if clean(row.get(col, '')):
            return label
    return ''

def family_key(row: dict) -> str:
    """Stable string used to group students into families.
    Prefers email; falls back to phone; finally to last-name+address."""
    e, p = fix_swapped(clean(row.get('Guardian #1 email')), clean(row.get('Guardian #1 phone')))
    if looks_like_email(e):
        return f'email:{e.lower()}'
    if looks_like_phone(p):
        return f'phone:{re.sub(chr(92)+"D","",p)}'  # strip non-digits
    # Fallback: last-name + address
    _, last = split_student_name(clean(row.get('Name', '')))
    addr = clean(row.get('Address', ''))
    if last or addr:
        return f'fallback:{last.lower()}|{addr.lower()}'
    return ''

# ─── Data classes ─────────────────────────────────────────────────────

@dataclass
class StudentRow:
    first_name: str
    last_name: str
    dob: str             # YYYY-MM-DD
    grade: str           # young_community / primary / kindergarten / ''
    classroom: str
    schedule_days: str
    schedule_times: str
    allergies: str
    nap: str
    aftercare: str
    is_new: str          # 'new' / ''
    start_date: str
    comments: str

@dataclass
class FamilyRow:
    parent1_first: str = ''
    parent1_last:  str = ''
    parent1_email: str = ''
    parent1_phone: str = ''
    parent1_address: str = ''
    parent2_first: str = ''
    parent2_last:  str = ''
    parent2_email: str = ''
    parent2_phone: str = ''
    parent2_address: str = ''
    students: list[StudentRow] = field(default_factory=list)

# ─── Main ─────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print('Usage: python scripts/reshape-enrollment-csv.py <input.csv> <school_name>', file=sys.stderr)
        return 1
    input_path = Path(argv[1])
    school_name = argv[2]

    if not input_path.exists():
        print(f'File not found: {input_path}', file=sys.stderr)
        return 1

    out_families = input_path.with_name(input_path.stem + '__families.csv')
    out_review   = input_path.with_name(input_path.stem + '__needs-review.csv')

    with input_path.open('r', encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))

    families: dict[str, FamilyRow] = {}
    review_rows: list[tuple[str, dict]] = []   # (reason, raw_row)
    auto_corrected = 0
    total_in = 0

    for row in rows:
        student_name_cell = clean(row.get('Name', ''))
        if not student_name_cell or student_name_cell.upper() == 'TOTAL COUNT':
            continue
        # Skip the "1" / count-marker row
        if student_name_cell == '1':
            continue
        total_in += 1

        first, last = split_student_name(student_name_cell)
        if not first:
            review_rows.append(('Could not parse student name', row))
            continue

        # Family key
        key = family_key(row)
        if not key:
            review_rows.append(('No guardian email/phone/last-name to group by', row))
            continue

        # Auto-correct swapped guardian email/phone
        g1_email_raw = clean(row.get('Guardian #1 email', ''))
        g1_phone_raw = clean(row.get('Guardian #1 phone', ''))
        g1_email, g1_phone = fix_swapped(g1_email_raw, g1_phone_raw)
        if (g1_email, g1_phone) != (g1_email_raw, g1_phone_raw):
            auto_corrected += 1

        g2_email_raw = clean(row.get('Guardian #2 email', ''))
        g2_phone_raw = clean(row.get('Guardian #2 phone', ''))
        g2_email, g2_phone = fix_swapped(g2_email_raw, g2_phone_raw)

        # Get-or-create family
        fam = families.setdefault(key, FamilyRow())
        # First time we see this family, set parents.
        if not fam.parent1_first:
            p1_first, p1_last = split_full_name(clean(row.get('Guardian #1 name', '')))
            if not p1_last:
                p1_last = last  # fall back to student's last name
            fam.parent1_first   = p1_first
            fam.parent1_last    = p1_last
            fam.parent1_email   = g1_email
            fam.parent1_phone   = g1_phone
            fam.parent1_address = clean(row.get('Address', ''))

            if g2_email or g2_phone or clean(row.get('Guardian #2 name', '')):
                p2_first, p2_last = split_full_name(clean(row.get('Guardian #2 name', '')))
                if not p2_last:
                    p2_last = last
                fam.parent2_first   = p2_first
                fam.parent2_last    = p2_last
                fam.parent2_email   = g2_email
                fam.parent2_phone   = g2_phone
                fam.parent2_address = clean(row.get('Address of parent #2', ''))

        # DOB
        dob = parse_birthday(row.get('Birthday', ''))
        if not dob:
            review_rows.append((f'Unparseable birthday for {first} {last}: {row.get("Birthday")!r}', row))

        student = StudentRow(
            first_name    = first,
            last_name     = last,
            dob           = dob,
            grade         = derive_grade(row),
            classroom     = clean(row.get('Room', '')),
            schedule_days = clean(row.get('Days', '')),
            schedule_times= clean(row.get('Times', '')),
            allergies     = clean(row.get('ALLERGIES/FOOD RESTRICTIONS', '')),
            nap           = clean(row.get('Nap?', '')),
            aftercare     = clean(row.get('care', '')),
            is_new        = clean(row.get('New Student?', '')),
            start_date    = clean(row.get('Start Date?', '')),
            comments      = clean(row.get('Comments', '')) or clean(row.get('Comments?', '')),
        )
        fam.students.append(student)

    # Write families.csv
    header = [
        'school_name',
        'family_display_name',
        'parent1_first_name', 'parent1_last_name', 'parent1_email', 'parent1_phone', 'parent1_is_primary',
        'parent2_first_name', 'parent2_last_name', 'parent2_email', 'parent2_phone',
        'address',
    ]
    for i in range(1, MAX_STUDENTS_PER_FAMILY + 1):
        header += [
            f'student{i}_first_name', f'student{i}_last_name', f'student{i}_dob',
            f'student{i}_grade', f'student{i}_classroom',
            f'student{i}_schedule_days', f'student{i}_schedule_times',
            f'student{i}_allergies', f'student{i}_nap', f'student{i}_aftercare',
            f'student{i}_is_new', f'student{i}_start_date', f'student{i}_comments',
        ]

    families_sorted = sorted(families.values(),
        key=lambda fr: (fr.parent1_last or '').lower() + (fr.parent1_first or '').lower())

    with out_families.open('w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        for fam in families_sorted:
            family_display = f'{fam.parent1_last} Family' if fam.parent1_last else (f'{fam.students[0].last_name} Family' if fam.students else '(unnamed)')
            row_out = [
                school_name,
                family_display,
                fam.parent1_first, fam.parent1_last, fam.parent1_email, fam.parent1_phone, 'true',
                fam.parent2_first, fam.parent2_last, fam.parent2_email, fam.parent2_phone,
                fam.parent1_address,
            ]
            # Pad students up to MAX_STUDENTS_PER_FAMILY
            for i in range(MAX_STUDENTS_PER_FAMILY):
                if i < len(fam.students):
                    s = fam.students[i]
                    row_out += [
                        s.first_name, s.last_name, s.dob,
                        s.grade, s.classroom,
                        s.schedule_days, s.schedule_times,
                        s.allergies, s.nap, s.aftercare,
                        s.is_new, s.start_date, s.comments,
                    ]
                else:
                    row_out += [''] * 13
            w.writerow(row_out)

    # Write needs-review.csv
    if review_rows:
        original_header = list(rows[0].keys()) if rows else []
        with out_review.open('w', encoding='utf-8', newline='') as f:
            w = csv.writer(f)
            w.writerow(['__reason__'] + original_header)
            for reason, row in review_rows:
                w.writerow([reason] + [row.get(h, '') for h in original_header])

    # ── Report ──
    multi = [fam for fam in families_sorted if len(fam.students) > 1]
    print()
    print('=' * 60)
    print(f'  RESHAPE COMPLETE — {school_name}')
    print('=' * 60)
    print(f'  Input rows processed:       {total_in}')
    print(f'  Families produced:          {len(families_sorted)}')
    print(f'  Multi-student families:     {len(multi)}')
    print(f'  Auto-corrected swapped:     {auto_corrected} row(s) (email/phone)')
    print(f'  Rows flagged for review:    {len(review_rows)}')
    # Also flag families that ended up with NO parent contact info — these
    # are importable but the parents won't be able to log in to the portal
    # until you backfill an email or phone.
    no_contact = [fam for fam in families_sorted
                  if not fam.parent1_email and not fam.parent1_phone]

    print()
    print(f'  -> {out_families}')
    if review_rows:
        print(f'  -> {out_review}  ** check these before importing')
    print('=' * 60)

    if multi:
        print()
        print(f'  Multi-student families detected ({len(multi)}):')
        for fam in multi:
            kids = ', '.join(f'{s.first_name} {s.last_name}' for s in fam.students)
            print(f'    {fam.parent1_first} {fam.parent1_last}: {kids}')

    if no_contact:
        print()
        print(f'  Families with NO parent email or phone ({len(no_contact)}):')
        for fam in no_contact:
            kids = ', '.join(f'{s.first_name} {s.last_name}' for s in fam.students)
            print(f'    {fam.parent1_first or "(no name)"} {fam.parent1_last}: {kids}')
        print('  -> These will import as families with students, but no parent contact.')
        print('     Add the missing parent info before sending enrollment emails.')

    if review_rows:
        print()
        print('  Needs-review rows:')
        for reason, row in review_rows:
            print(f'    {reason}  ({row.get("Name", "?")})')

    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
