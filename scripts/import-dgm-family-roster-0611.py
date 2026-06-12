#!/usr/bin/env python3
"""
DGM clean family import from "Family Roster as of 6 11.xlsx"
(one row per PARENT per student; has emails + mobile numbers).

Operator decisions (2026-06-12):
  1. ARCHIVE (status='inactive') active students NOT in this sheet,
     then archive families left with zero active students (+ their
     parents). Reversible; no hard deletes.
  2. Parents: SHEET IS TRUTH for families with sheet students.
     - match existing parents by email -> update name/phone
     - insert sheet parents missing from the family
     - deactivate other active parents in those families
     (ghl_contact_id / logins / PINs preserved on matched parents)
  3. The 5 brand-new students -> created, enrolled 2026-27.
     The 2 returning students -> reactivated, enrollment -> 2026-27.

The Carter (DEMO) family is excluded from everything.

  python import-dgm-family-roster-0611.py            # dry-run
  python import-dgm-family-roster-0611.py --apply
"""
import sys, re, json
import openpyxl
import psycopg2
import psycopg2.extras

XLSX = r"C:\Users\thelo\Downloads\Family Roster as of 6 11.xlsx"
SCHOOL_ID = "cfa9030d-c8fe-49ae-a9e7-f1003844ec07"
DEMO_FAMILY_ID = "cdf70975-b0a4-4f3a-8a34-2858bfffe750"
YEAR = "2026-27"
APPLY = "--apply" in sys.argv

def db_url():
    for line in open(".env.local", encoding="utf-8"):
        m = re.match(r"^DATABASE_URL=(.*)$", line.strip())
        if m: return m.group(1).strip().strip('"')
    raise SystemExit("DATABASE_URL not found")

def s(v):
    if v is None: return None
    t = str(v).strip()
    return t or None

def norm_email(v):
    t = s(v)
    return t.lower() if t and "@" in t else None

def norm_phone(v):
    if v is None: return None
    d = re.sub(r"\D", "", str(v))
    if len(d) == 10: d = "1" + d
    return d or None

# ── load sheet ──────────────────────────────────────────────────────
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
rows = list(wb["Sheet1"].iter_rows(values_only=True))
# cols: 0 #, 1 APID, 2 STUDENT NAME, 3 CONTACT GUID, 4 HOUSEHOLD ID,
#       5 P-FIRST, 6 P-LAST, 7 EMAIL, 8-12 address, 13 MOBILE,
#       14 UNIQUE ID, 15 S-LAST, 16 S-FIRST, 17 ##PROGRAM
data = [r for r in rows[1:] if r and r[1] and r[14]]

# per-student: info + ordered parent list
students = {}   # uid -> {apid, hh, last, first, program, parents:[{first,last,email,phone,guid}]}
for r in data:
    uid = s(r[14])
    st = students.setdefault(uid, {
        "apid": s(r[1]), "hh": s(r[4]), "last": s(r[15]), "first": s(r[16]),
        "program": s(r[17]), "parents": [],
    })
    em = norm_email(r[7])
    p = {"first": s(r[5]) or "", "last": s(r[6]) or "", "email": em,
         "phone": norm_phone(r[13]), "guid": s(r[3])}
    if not any(x["email"] == em and x["first"] == p["first"] for x in st["parents"]):
        st["parents"].append(p)

print(f"sheet: {len(data)} parent-rows -> {len(students)} students")

conn = psycopg2.connect(db_url())
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# DB state
cur.execute("""SELECT s.id, s.family_id, s.status, s.first_name, s.last_name,
                      s.metadata->>'unique_id' uid, s.metadata->>'household_id' hh
               FROM students s WHERE s.school_id=%s""", (SCHOOL_ID,))
db_students = cur.fetchall()
by_uid = {x["uid"]: x for x in db_students if x["uid"]}
hh_to_family = {}
for x in db_students:
    if x["hh"] and x["hh"] not in hh_to_family:
        hh_to_family[x["hh"]] = x["family_id"]

sheet_uids = set(students.keys())

# ── 1. returning (inactive or 2025-26) + brand-new students ────────
returning = [u for u in sheet_uids if u in by_uid]
brand_new = [u for u in sheet_uids if u not in by_uid]
# reactivation set: matched but inactive OR no current-year enrolled enrollment
cur.execute("""SELECT s.id FROM students s
               WHERE s.school_id=%s AND s.status='active'
                 AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=s.id AND e.academic_year=%s AND e.status='enrolled')""",
            (SCHOOL_ID, YEAR))
current_ids = {x["id"] for x in cur.fetchall()}

reactivate = [by_uid[u] for u in returning if by_uid[u]["id"] not in current_ids]
print(f"matched: {len(returning)-len(reactivate)} already current · reactivate: {len(reactivate)} · brand-new: {len(brand_new)}")

new_family_cache = {}
def family_for(hh, last):
    fam = hh_to_family.get(hh) or new_family_cache.get(hh)
    if fam: return fam, False
    if APPLY:
        cur.execute("INSERT INTO families (school_id, display_name, status) VALUES (%s,%s,'active') RETURNING id",
                    (SCHOOL_ID, f"{last} Family"))
        fam = cur.fetchone()["id"]
    else:
        fam = f"<new:{hh}>"
    if hh: new_family_cache[hh] = fam
    return fam, True

created = 0
fam_created = 0
for u in brand_new:
    st = students[u]
    fam, is_new = family_for(st["hh"], st["last"])
    if is_new: fam_created += 1
    md = {"unique_id": u, "household_id": st["hh"], "apid": st["apid"],
          "first_name": st["first"], "last_name": st["last"], "program": st["program"]}
    if APPLY:
        cur.execute("""INSERT INTO students (family_id, school_id, first_name, last_name, status, metadata)
                       VALUES (%s,%s,%s,%s,'active',%s::jsonb) RETURNING id""",
                    (fam, SCHOOL_ID, st["first"], st["last"], json.dumps(md)))
        sid = cur.fetchone()["id"]
        cur.execute("""INSERT INTO enrollments (student_id, school_id, academic_year, status, enrolled_at, metadata)
                       VALUES (%s,%s,%s,'enrolled',now(),'{}'::jsonb)""", (sid, SCHOOL_ID, YEAR))
    created += 1

react_count = 0
for x in reactivate:
    if x["family_id"] == DEMO_FAMILY_ID: continue
    if APPLY:
        cur.execute("UPDATE students SET status='active', updated_at=now() WHERE id=%s", (x["id"],))
        cur.execute("""UPDATE enrollments SET academic_year=%s, status='enrolled', updated_at=now()
                       WHERE student_id=%s""", (YEAR, x["id"]))
        cur.execute("SELECT 1 FROM enrollments WHERE student_id=%s LIMIT 1", (x["id"],))
        if cur.fetchone() is None:
            cur.execute("""INSERT INTO enrollments (student_id, school_id, academic_year, status, enrolled_at, metadata)
                           VALUES (%s,%s,%s,'enrolled',now(),'{}'::jsonb)""", (x["id"], SCHOOL_ID, YEAR))
    react_count += 1
print(f"{'created' if APPLY else 'would create'} {created} students ({fam_created} new families); reactivated {react_count}")

# ── 2. parents: sheet is truth per family ───────────────────────────
# family -> ordered sheet parents (deduped by email)
fam_parents = {}
for u in sheet_uids:
    st = students[u]
    db_row = by_uid.get(u)
    fam = db_row["family_id"] if db_row else (hh_to_family.get(st["hh"]) or new_family_cache.get(st["hh"]))
    if not fam or fam == DEMO_FAMILY_ID: continue
    lst = fam_parents.setdefault(fam, [])
    for p in st["parents"]:
        if p["email"] and not any(x["email"] == p["email"] for x in lst):
            lst.append(p)
        elif not p["email"] and not any(x["first"] == p["first"] and x["last"] == p["last"] for x in lst):
            lst.append(p)

upd = ins = deact = 0
for fam, plist in fam_parents.items():
    if str(fam).startswith("<new:"):  # dry-run placeholder family
        ins += len(plist)
        continue
    cur.execute("""SELECT id, first_name, last_name, lower(email) email, is_primary, status
                   FROM parents WHERE family_id=%s AND school_id=%s""", (fam, SCHOOL_ID))
    existing = cur.fetchall()
    by_email = {x["email"]: x for x in existing if x["email"]}
    sheet_emails = {p["email"] for p in plist if p["email"]}
    for p in plist:
        match = by_email.get(p["email"]) if p["email"] else None
        if match:
            if APPLY:
                cur.execute("""UPDATE parents SET first_name=%s, last_name=%s,
                                 phone=COALESCE(%s, phone), status='active', updated_at=now()
                               WHERE id=%s""", (p["first"], p["last"], p["phone"], match["id"]))
            upd += 1
        else:
            if APPLY:
                cur.execute("""INSERT INTO parents (family_id, school_id, first_name, last_name, email, phone, role, is_primary, status)
                               VALUES (%s,%s,%s,%s,%s,%s,'parent',false,'active')""",
                            (fam, SCHOOL_ID, p["first"], p["last"], p["email"], p["phone"]))
            ins += 1
    # deactivate active parents not in the sheet for this family
    for x in existing:
        if x["status"] == "active" and (x["email"] or "") not in sheet_emails:
            if APPLY:
                cur.execute("UPDATE parents SET status='inactive', is_primary=false, updated_at=now() WHERE id=%s", (x["id"],))
            deact += 1
print(f"parents: {'updated' if APPLY else 'would update'} {upd}, insert {ins}, deactivate {deact} (across {len(fam_parents)} families)")

# ── 3. archive non-sheet active students + empty families ───────────
to_archive = [x for x in db_students
              if x["status"] == "active" and x["family_id"] != DEMO_FAMILY_ID
              and (x["uid"] or "") not in sheet_uids]
if APPLY and to_archive:
    cur.execute("UPDATE students SET status='inactive', updated_at=now() WHERE id = ANY(%s::uuid[])",
                ([str(x["id"]) for x in to_archive],))
print(f"{'archived' if APPLY else 'would archive'} {len(to_archive)} students not in sheet")
no_uid = [f"{x['first_name']} {x['last_name']}" for x in to_archive if not x["uid"]]
if no_uid: print(f"  (includes {len(no_uid)} without unique_id: {', '.join(no_uid[:8])})")

if APPLY:
    cur.execute("""UPDATE families f SET status='inactive', updated_at=now()
                   WHERE f.school_id=%s AND f.id <> %s AND f.status='active'
                     AND NOT EXISTS (SELECT 1 FROM students s WHERE s.family_id=f.id AND s.status='active')
                   RETURNING f.id""", (SCHOOL_ID, DEMO_FAMILY_ID))
    fam_arch = [x["id"] for x in cur.fetchall()]
    if fam_arch:
        cur.execute("UPDATE parents SET status='inactive', is_primary=false, updated_at=now() WHERE family_id = ANY(%s::uuid[])",
                    ([str(f) for f in fam_arch],))
    print(f"archived {len(fam_arch)} now-empty families (+ their parents)")
else:
    cur.execute("""SELECT COUNT(*)::int n FROM families f
                   WHERE f.school_id=%s AND f.id <> %s AND f.status='active'
                     AND NOT EXISTS (SELECT 1 FROM students s WHERE s.family_id=f.id AND s.status='active'
                                     AND NOT (s.metadata->>'unique_id' IS NULL AND f.id <> %s)
                                    )""", (SCHOOL_ID, DEMO_FAMILY_ID, DEMO_FAMILY_ID))
    print("(family archiving computed at apply time)")

# ── 4. ensure exactly one primary parent per active family ──────────
if APPLY:
    cur.execute("""
      WITH fams AS (SELECT id FROM families WHERE school_id=%s AND status='active'),
      ranked AS (
        SELECT p.id, p.family_id,
               ROW_NUMBER() OVER (PARTITION BY p.family_id ORDER BY p.is_primary DESC, p.created_at) rn
        FROM parents p JOIN fams f ON f.id=p.family_id
        WHERE p.status='active'
      )
      UPDATE parents p SET is_primary = (r.rn = 1)
      FROM ranked r WHERE r.id = p.id AND (p.is_primary <> (r.rn=1))""", (SCHOOL_ID,))
    print(f"primary flags normalized ({cur.rowcount} adjusted)")

if APPLY:
    conn.commit()
    cur.execute("""SELECT COUNT(*) FILTER (WHERE status='active')::int act,
                          COUNT(*)::int total FROM students WHERE school_id=%s""", (SCHOOL_ID,))
    r = cur.fetchone()
    cur.execute("""SELECT COUNT(*)::int n FROM parents WHERE school_id=%s AND status='active' AND email IS NOT NULL""", (SCHOOL_ID,))
    pe = cur.fetchone()["n"]
    print(f"\nCOMMITTED. active students: {r['act']} (of {r['total']}) · active parents with email: {pe}")
else:
    conn.rollback()
    print("\nDRY-RUN — nothing written. Re-run with --apply.")
cur.close(); conn.close()
