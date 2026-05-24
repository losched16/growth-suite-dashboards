"""
Enriches an already-imported DonorPerfect dataset with the campaign /
response / narrative "flag" columns from a DPMigration*Flags*.csv
export. Also opportunistically refreshes bio fields on dp_donors where
the CSV differs from the DB.

Idempotent: re-running just re-asserts the same values. Safe to retry.

USAGE:
  python scripts/enrich-dp-gifts-flags.py \\
      <school_id> <csv_path> [--apply]

Default is DRY RUN. Pass --apply to commit.

Matches:
  - dp_gifts row by (school_id, dp_gift_id) — DonorPerfect's GIFT_ID
  - dp_donors row by (school_id, dp_donor_id) — DonorPerfect's DONOR_ID

What gets updated on a match:
  GIFTS:
    solicit_code, solicit_code_descr,
    sub_solicit_code, sub_solicit_code_descr,
    response_code, narrative
  DONORS (bio refresh, only where CSV != DB):
    title, suffix, prof_title, salutation, opt_line,
    address, address2, city, state, state_descr, zip,
    email (+ email_lower), mobile_phone, home_phone, business_phone

Rows that don't match an existing gift / donor are reported but NOT
auto-inserted — caller can decide whether to follow up.
"""

from __future__ import annotations

import csv
import sys
import os
from datetime import datetime
from pathlib import Path
import psycopg2
from psycopg2.extras import execute_batch

# ── Load .env.local for DATABASE_URL ─────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
env_path = PROJECT_ROOT / '.env.local'
if env_path.exists():
    for line in env_path.read_text(encoding='utf-8').splitlines():
        t = line.strip()
        if not t or t.startswith('#'): continue
        eq = t.find('=')
        if eq == -1: continue
        k, v = t[:eq].strip(), t[eq+1:].strip()
        os.environ.setdefault(k, v)

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('DATABASE_URL not set', file=sys.stderr); sys.exit(1)

# ── Helpers ──────────────────────────────────────────────────────────

def clean(v: str | None) -> str | None:
    """Strip whitespace; treat blank / '?' / 'nan' as None."""
    if v is None: return None
    s = str(v).strip()
    if not s or s == '?' or s.lower() == 'nan': return None
    return s

def clean_email(v: str | None) -> str | None:
    s = clean(v)
    if not s: return None
    s = s.lower()
    if '@' not in s or '.' not in s.split('@', 1)[-1]: return None
    return s

# Bio columns we refresh on dp_donors. (col_name, csv_header).
BIO_COLS = [
    ('title',          'title'),
    ('suffix',         'suffix'),
    ('prof_title',     'prof_title'),
    ('salutation',     'salutation'),
    ('opt_line',       'opt_line'),
    ('address',        'address'),
    ('address2',       'address2'),
    ('city',           'city'),
    ('state',          'state'),
    ('state_descr',    'STATE_DESCR'),
    ('zip',            'zip'),
    ('email',          'email'),
    ('mobile_phone',   'mobile_phone'),
    ('home_phone',     'home_phone'),
    ('business_phone', 'business_phone'),
]

# ── Main ─────────────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print('Usage: python scripts/enrich-dp-gifts-flags.py <school_id> <csv_path> [--apply]', file=sys.stderr)
        return 1
    school_id = argv[1]
    csv_path = Path(argv[2])
    apply_mode = '--apply' in argv

    if not csv_path.exists():
        print(f'File not found: {csv_path}', file=sys.stderr); return 1

    # Read all rows
    with csv_path.open('r', encoding='utf-8-sig', newline='') as f:
        # The CSV has duplicate DONOR_ID headers — DictReader collapses
        # them. Use raw reader + the FIRST occurrence as the canonical
        # donor id (which it always is in DonorPerfect exports).
        reader = csv.reader(f)
        headers = next(reader)
        rows_raw = list(reader)

    def col_idx(name: str) -> int:
        return headers.index(name)

    DONOR_ID = col_idx('DONOR_ID')
    GIFT_ID = col_idx('GIFT_ID')
    SOLICIT_CODE = col_idx('SOLICIT_CODE')
    SOLICIT_CODE_DESCR = col_idx('SOLICIT_CODE_DESCR')
    SUB_SOLICIT_CODE = col_idx('SUB_SOLICIT_CODE')
    SUB_SOLICIT_CODE_DESCR = col_idx('SUB_SOLICIT_CODE_DESCR')
    RESPONSE_CODE = col_idx('RESPONSE_CODE')
    NARRATIVE = col_idx('NARRATIVE')
    bio_indices = {db_col: col_idx(hdr) for db_col, hdr in BIO_COLS}

    print(f'Loaded {len(rows_raw)} rows from {csv_path.name}')
    print(f'Target school: {school_id}')
    print(f'Mode: {"APPLY" if apply_mode else "DRY RUN"}')
    print()

    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    conn.autocommit = False
    cur = conn.cursor()

    # ── Pre-fetch existing data for matching ──────────────────────────
    cur.execute(
        'SELECT dp_gift_id FROM dp_gifts WHERE school_id = %s',
        (school_id,))
    existing_gift_ids = {r[0] for r in cur.fetchall()}
    print(f'Existing dp_gifts for this school: {len(existing_gift_ids)}')

    cur.execute(
        'SELECT dp_donor_id, ' + ', '.join(col for col, _ in BIO_COLS) +
        ' FROM dp_donors WHERE school_id = %s',
        (school_id,))
    db_donors = {row[0]: dict(zip([c for c, _ in BIO_COLS], row[1:])) for row in cur.fetchall()}
    print(f'Existing dp_donors for this school: {len(db_donors)}')
    print()

    # ── Plan updates ──────────────────────────────────────────────────
    gift_updates: list[tuple] = []   # (gift_id, solicit, ...) in update order
    gifts_unmatched: list[str] = []
    bio_updates: dict[str, dict[str, tuple]] = {}  # donor_id → {col: (old, new)}
    donors_unmatched: set[str] = set()

    for r in rows_raw:
        gift_id = clean(r[GIFT_ID])
        donor_id = clean(r[DONOR_ID])
        if not gift_id:
            continue

        # Gift-level update — always queue if flag columns are populated.
        sc       = clean(r[SOLICIT_CODE])
        sc_descr = clean(r[SOLICIT_CODE_DESCR])
        ssc      = clean(r[SUB_SOLICIT_CODE])
        ssc_descr= clean(r[SUB_SOLICIT_CODE_DESCR])
        rc       = clean(r[RESPONSE_CODE])
        narr     = clean(r[NARRATIVE])
        if gift_id in existing_gift_ids:
            gift_updates.append((sc, sc_descr, ssc, ssc_descr, rc, narr, school_id, gift_id))
        else:
            gifts_unmatched.append(gift_id)

        # Donor bio refresh — compare each tracked column.
        if donor_id and donor_id in db_donors:
            db_row = db_donors[donor_id]
            diffs = bio_updates.setdefault(donor_id, {})
            for db_col, csv_idx in bio_indices.items():
                csv_val = clean(r[csv_idx])
                if db_col == 'email':
                    csv_val = clean_email(r[csv_idx])
                if csv_val is None:
                    continue  # don't blank existing data with a missing cell
                db_val = db_row.get(db_col)
                if (db_val or None) != csv_val:
                    diffs[db_col] = (db_val, csv_val)
            if not diffs:
                bio_updates.pop(donor_id, None)  # nothing changed for this donor
        elif donor_id:
            donors_unmatched.add(donor_id)

    print('=' * 60)
    print(f'  Gift-flag updates queued:        {len(gift_updates)}')
    print(f'  Gift rows with no match (skip):  {len(gifts_unmatched)}')
    print(f'  Donors with bio diffs:           {len(bio_updates)}')
    print(f'  Donors not in DB (skip):         {len(donors_unmatched)}')
    print('=' * 60)

    if bio_updates:
        # Show a sample of bio diffs (first 5)
        print()
        print('Sample bio diffs (first 5 donors):')
        for i, (did, diffs) in enumerate(sorted(bio_updates.items())[:5]):
            print(f'  donor {did}:')
            for col, (old, new) in diffs.items():
                print(f'    {col}:  {old!r}  ->  {new!r}')

    if not apply_mode:
        print()
        print('** DRY RUN — re-run with --apply to commit. **')
        cur.close(); conn.close()
        return 0

    # ── Apply ─────────────────────────────────────────────────────────
    print()
    print('Applying gift-flag updates...')
    execute_batch(cur,
        '''UPDATE dp_gifts SET
              solicit_code           = %s,
              solicit_code_descr     = %s,
              sub_solicit_code       = %s,
              sub_solicit_code_descr = %s,
              response_code          = %s,
              narrative              = %s
            WHERE school_id = %s AND dp_gift_id = %s''',
        gift_updates, page_size=200,
    )
    print(f'  Updated {len(gift_updates)} gift row(s).')

    print('Applying bio refreshes...')
    for donor_id, diffs in bio_updates.items():
        # Build a dynamic UPDATE — only the changed columns.
        set_clauses = []
        params: list = []
        for col, (_, new) in diffs.items():
            set_clauses.append(f'{col} = %s')
            params.append(new)
            if col == 'email':
                set_clauses.append('email_lower = %s')
                params.append(new.lower() if new else None)
        if not set_clauses:
            continue
        params.extend([school_id, donor_id])
        cur.execute(
            f'UPDATE dp_donors SET {", ".join(set_clauses)} WHERE school_id = %s AND dp_donor_id = %s',
            params,
        )
    print(f'  Refreshed bio on {len(bio_updates)} donor row(s).')

    conn.commit()
    cur.close(); conn.close()
    print()
    print('=' * 60)
    print('  DONE. Changes committed.')
    print('=' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
