"""
One-off importer for FACTS Management exports into the platform DB.

Usage:
    DATABASE_URL=postgres://... python scripts/import-facts.py \
        --school-id <uuid> \
        --customers "Customer List - XXXXX.xlsx" \
        --students  "Student List - XXXXX.xlsx" \
        --balances  "Balances Report - XXXXX.xlsx"

Matches FACTS rows to family-graph by name (FACTS uses "Last, First").
Best-effort: prints stats for matched vs unmatched.
"""
import argparse
import os
import re
import sys
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

def norm(s):
    """Lowercase, strip whitespace, collapse to single spaces."""
    if not isinstance(s, str):
        return ""
    return re.sub(r"\s+", " ", s.strip().lower())

def parse_last_first(s):
    """'Alami, Omar' -> ('Alami', 'Omar')"""
    if not isinstance(s, str) or "," not in s:
        return ("", "")
    parts = [p.strip() for p in s.split(",", 1)]
    if len(parts) != 2:
        return ("", "")
    return (parts[0], parts[1])

def parse_facts_number(v):
    """FACTS numbers come through pandas as floats like 5.129962e+09 — convert to int string."""
    if v is None or pd.isna(v):
        return None
    if isinstance(v, (int,)):
        return str(v)
    if isinstance(v, float):
        return str(int(v))
    return str(v).strip() or None

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--customers", required=True)
    p.add_argument("--students", required=True)
    p.add_argument("--balances", required=True)
    args = p.parse_args()

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL env var required")

    print(f"reading {args.customers}")
    df_cust = pd.read_excel(args.customers, header=1)
    print(f"reading {args.students}")
    df_stu = pd.read_excel(args.students, header=1)
    print(f"reading {args.balances}")
    df_bal = pd.read_excel(args.balances, header=1)
    print(f"customers={len(df_cust)} students={len(df_stu)} balances={len(df_bal)}")

    conn = psycopg2.connect(db)
    conn.autocommit = False
    cur = conn.cursor()

    # ---- Load existing family-graph for matching ----------------------------
    cur.execute(
        """SELECT s.id, s.first_name, s.last_name, s.family_id,
                  p.first_name, p.last_name, LOWER(p.email)
           FROM students s
           LEFT JOIN parents p
               ON p.family_id = s.family_id AND p.is_primary = true
           WHERE s.school_id = %s AND s.status = 'active'""",
        (args.school_id,),
    )
    fg_rows = cur.fetchall()
    # Index: (student last, student first, parent last) -> student_id
    student_index = {}
    family_by_parent = {}  # (parent_last, parent_first) -> family_id
    family_by_email = {}   # email -> family_id
    for sid, sfn, sln, fid, pfn, pln, pem in fg_rows:
        key = (norm(sln), norm(sfn), norm(pln) if pln else "")
        student_index.setdefault(key, sid)
        # Also a looser key without parent for fallback
        student_index.setdefault((norm(sln), norm(sfn), ""), sid)
        if pfn and pln:
            family_by_parent.setdefault((norm(pln), norm(pfn)), fid)
        if pem:
            family_by_email.setdefault(pem.strip(), fid)

    # Also index by P2 emails — FACTS often lists Parent 2 as the "customer"
    cur.execute(
        """SELECT family_id, LOWER(email) FROM parents
           WHERE school_id = %s AND email IS NOT NULL AND email <> ''""",
        (args.school_id,),
    )
    for fid, em in cur.fetchall():
        family_by_email.setdefault((em or "").strip(), fid)

    print(f"family-graph: {len(fg_rows)} students, {len(family_by_parent)} primary parents, {len(family_by_email)} emails indexed")

    # ---- IMPORT customers ---------------------------------------------------
    print()
    print("=== Customers ===")
    cust_rows = []
    cust_matched = 0
    for _, r in df_cust.iterrows():
        fn = str(r.get("First Name", "") or "")
        ln = str(r.get("Last Name", "") or "")
        cnum = parse_facts_number(r.get("FACTS Customer Number"))
        cid = parse_facts_number(r.get("Customer ID"))
        emails = (r.get("E-mail") or "").strip() if isinstance(r.get("E-mail"), str) else None
        state = r.get("State") or None
        status = r.get("Status") or None
        online = r.get("Online Code") or None

        # Match by parent name (last, first); fall back to any email match
        match_fid = family_by_parent.get((norm(ln), norm(fn)))
        method = "by_name" if match_fid else None
        if not match_fid and emails:
            # FACTS exports emails newline-separated, sometimes with trailing \n
            for em in re.split(r"[\n,;]+", emails):
                em = em.strip().lower()
                if em and em in family_by_email:
                    match_fid = family_by_email[em]
                    method = "by_email"
                    break
        if not method:
            method = "unmatched"
        if match_fid:
            cust_matched += 1

        cust_rows.append((args.school_id, cnum, cid, fn, ln, emails, state, status, online, match_fid, method))

    cur.execute("DELETE FROM facts_customers WHERE school_id = %s", (args.school_id,))
    execute_values(
        cur,
        """INSERT INTO facts_customers
           (school_id, facts_customer_number, facts_customer_id, first_name, last_name,
            emails, state, status, online_code, matched_family_id, match_method)
           VALUES %s
           ON CONFLICT (school_id, facts_customer_number) DO NOTHING""",
        cust_rows,
    )
    print(f"inserted {len(cust_rows)} customers; matched to families: {cust_matched}/{len(cust_rows)} ({100*cust_matched//max(len(cust_rows),1)}%)")

    # Build customer-number -> matched_family_id and -> facts_customer_uuid lookups
    cur.execute(
        "SELECT id, facts_customer_number, matched_family_id FROM facts_customers WHERE school_id = %s",
        (args.school_id,),
    )
    fc_by_number = {row[1]: (row[0], row[2]) for row in cur.fetchall() if row[1]}

    # ---- IMPORT students ----------------------------------------------------
    print()
    print("=== Students ===")
    stu_rows = []
    stu_matched = 0
    stu_skipped_no_id = 0
    for _, r in df_stu.iterrows():
        fn = str(r.get("First Name", "") or "").strip()
        ln = str(r.get("Last Name", "") or "").strip()
        sid = parse_facts_number(r.get("Student ID"))
        if not sid:
            stu_skipped_no_id += 1
            continue
        cust_name = str(r.get("Customer", "") or "").strip()
        grade = r.get("Grade") or None
        status = r.get("Status") or None

        parent_last, _parent_first = parse_last_first(cust_name)
        # Try with parent's last name disambiguation, then without
        key_with_parent = (norm(ln), norm(fn), norm(parent_last))
        key_without = (norm(ln), norm(fn), "")
        match_sid = student_index.get(key_with_parent) or student_index.get(key_without)
        method = "by_name+parent" if student_index.get(key_with_parent) else (
            "by_name_only" if student_index.get(key_without) else "unmatched"
        )
        if match_sid:
            stu_matched += 1

        stu_rows.append((args.school_id, sid, fn, ln, cust_name, grade, status, match_sid, method))

    cur.execute("DELETE FROM facts_students WHERE school_id = %s", (args.school_id,))
    execute_values(
        cur,
        """INSERT INTO facts_students
           (school_id, facts_student_id, first_name, last_name, customer_name, grade, status, matched_student_id, match_method)
           VALUES %s
           ON CONFLICT (school_id, facts_student_id) DO NOTHING""",
        stu_rows,
    )
    print(f"inserted {len(stu_rows)} students; matched: {stu_matched}/{len(stu_rows)} ({100*stu_matched//max(len(stu_rows),1)}%); skipped (no FACTS ID): {stu_skipped_no_id}")

    # Build a name -> matched_student_id index for balances lookup
    name_to_student = {}
    for sid, fn, ln, _fid, _pfn, _pln, _pem in fg_rows:
        name_to_student.setdefault((norm(ln), norm(fn)), sid)

    # ---- IMPORT balances ---------------------------------------------------
    print()
    print("=== Balances ===")
    bal_rows = []
    bal_matched = 0
    bal_matched_family_only = 0
    bal_skipped = 0
    for _, r in df_bal.iterrows():
        term = str(r.get("Term", "") or "").strip()
        # Skip junk rows: parameter rows, grand totals, NaN, anything that
        # doesn't look like a real term (must contain a 4-digit year).
        if (
            not term
            or term.lower() == "nan"
            or term.startswith("Term:")
            or term.startswith("Parameters")
            or term.startswith("Display By")
            or term.startswith("View Balances")
            or term.startswith("As Of Date")
            or term.startswith("Grand Totals")
            or not re.search(r"\d{4}", term)
        ):
            bal_skipped += 1
            continue
        cnum = parse_facts_number(r.get("Customer Number"))
        cust_name = str(r.get("Customer", "") or "").strip()
        stu_name = str(r.get("Student", "") or "").strip()
        grade = r.get("Grade") or None

        def num(field):
            v = r.get(field)
            if v is None or pd.isna(v):
                return 0
            try:
                return float(v)
            except (ValueError, TypeError):
                return 0

        # Match student by name (Last, First in FACTS)
        s_last, s_first = parse_last_first(stu_name)
        match_sid = name_to_student.get((norm(s_last), norm(s_first)))

        # Match family via FACTS customer number (cached) OR by parent name
        match_fid = None
        match_cust_uuid = None
        if cnum and cnum in fc_by_number:
            match_cust_uuid, match_fid = fc_by_number[cnum]
        if not match_fid:
            p_last, p_first = parse_last_first(cust_name)
            match_fid = family_by_parent.get((norm(p_last), norm(p_first)))

        if match_sid:
            bal_matched += 1
        elif match_fid:
            bal_matched_family_only += 1

        method = "student+family" if (match_sid and match_fid) else (
            "student_only" if match_sid else (
                "family_only" if match_fid else "unmatched"
            )
        )

        bal_rows.append((
            args.school_id, term, cnum, cust_name, stu_name, grade,
            num("Charges"), num("Credits"), num("Payments"),
            num("Remaining Amount Due"), num("Remaining Credit Balance"), num("Delinquent Balance"),
            match_sid, match_fid, match_cust_uuid, method,
        ))

    cur.execute("DELETE FROM facts_balances WHERE school_id = %s", (args.school_id,))
    execute_values(
        cur,
        """INSERT INTO facts_balances
           (school_id, term, facts_customer_number, customer_name, facts_student_name, grade,
            charges, credits, payments, remaining_amount_due, remaining_credit_balance, delinquent_balance,
            matched_student_id, matched_family_id, matched_customer_id, match_method)
           VALUES %s
           ON CONFLICT (school_id, term, customer_name, facts_student_name) DO UPDATE SET
              charges = EXCLUDED.charges,
              credits = EXCLUDED.credits,
              payments = EXCLUDED.payments,
              remaining_amount_due = EXCLUDED.remaining_amount_due,
              remaining_credit_balance = EXCLUDED.remaining_credit_balance,
              delinquent_balance = EXCLUDED.delinquent_balance,
              matched_student_id = EXCLUDED.matched_student_id,
              matched_family_id = EXCLUDED.matched_family_id,
              matched_customer_id = EXCLUDED.matched_customer_id,
              match_method = EXCLUDED.match_method,
              imported_at = now()""",
        bal_rows,
    )
    print(f"inserted/updated {len(bal_rows)} balance rows (skipped {bal_skipped} junk rows)")
    print(f"  matched to student: {bal_matched}/{len(bal_rows)} ({100*bal_matched//max(len(bal_rows),1)}%)")
    print(f"  matched only to family (no student): {bal_matched_family_only}")
    print(f"  totally unmatched: {len(bal_rows) - bal_matched - bal_matched_family_only}")

    conn.commit()
    cur.close()
    conn.close()

    print()
    print("done.")

if __name__ == "__main__":
    main()
