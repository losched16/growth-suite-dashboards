#!/usr/bin/env python3
"""
DGM roster re-import from "Full Student Spreadsheet as of 6-8".

Match key: students.metadata->>'unique_id'  <->  sheet UNIQUE ID.

  - MATCHED (221): update structured fields + MERGE metadata (preserving
    keys not in the sheet: ghl_contact_id, ghl_slot, apid, form_completion)
    + upsert allergies into student_health_profiles.
  - NEW (42): create family (resolve by household_id, else new) + parent(s)
    parsed from PARENT/GUARDIAN (no email in sheet) + student + enrollment
    (status=enrolled, academic_year=2026-27).
  - DB-only (91 not in sheet): LEFT UNTOUCHED per operator decision.

Dry-run by default. Pass --apply to write.

  python import-dgm-roster-0608.py            # dry-run report
  python import-dgm-roster-0608.py --apply    # write
"""
import sys, re, json, datetime
import openpyxl
import psycopg2

XLSX = r"C:\Users\thelo\Downloads\Full Student Spreadsheet as of 6-8 (1).xlsx"
SCHOOL_ID = "cfa9030d-c8fe-49ae-a9e7-f1003844ec07"
ACADEMIC_YEAR = "2026-27"
APPLY = "--apply" in sys.argv

# ── DB URL from .env.local ──────────────────────────────────────────
def db_url():
    for line in open(".env.local", encoding="utf-8"):
        m = re.match(r"^DATABASE_URL=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"')
    raise SystemExit("DATABASE_URL not found in .env.local")

# ── helpers ─────────────────────────────────────────────────────────
def s(v):
    if v is None: return None
    t = str(v).strip()
    return t or None

def norm_phone(v):
    if v is None: return None
    d = re.sub(r"\D", "", str(v))
    if len(d) == 10: d = "1" + d
    return d or None

def iso_dt(v):
    if v is None: return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return datetime.datetime(v.year, v.month, v.day).strftime("%Y-%m-%dT00:00:00.000Z")
    return s(v)

def dob_date(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return datetime.date(v.year, v.month, v.day)
    return None

def parse_parents(raw):
    """'Omar Alami and Wendy Brightwell' -> [(first,last), ...]"""
    if not raw: return []
    parts = re.split(r"\s+and\s+|\s*&\s*|\s*;\s*|\s*,\s*", str(raw).strip())
    out = []
    for p in parts:
        p = p.strip()
        if not p: continue
        toks = p.split()
        if len(toks) == 1:
            out.append((toks[0], ""))
        else:
            out.append((toks[0], " ".join(toks[1:])))
    return out

# ── load sheet ──────────────────────────────────────────────────────
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb["Sheet1"]
rows = list(ws.iter_rows(values_only=True))
hdr = [str(c).strip() if c is not None else "" for c in rows[1]]
def col(name):
    return hdr.index(name) if name in hdr else -1

C = {
    "last": col("LAST NAME"), "first": col("FIRST NAME"), "middle": col("MIDDLE NAME"),
    "uid": col("UNIQUE ID"), "hh": col("HOUSEHOLD ID"), "lang": col("LANGUAGE"),
    "active": col("ACTIVE/INACTIVE"), "grade": col("GRADE LEVEL"), "age": col("AGE"),
    "parent": col("PARENT/GUARDIAN"), "street": col("STUDENT STREET"), "city": col("STUDENT CITY"),
    "state": col("STUDENT STATE"), "zip": col("STUDENT ZIP"), "phone": col("HOUSEHOLD PHONE"),
    "homeroom": col("HOMEROOM"), "gender": col("GENDER"), "dob": col("BIRTH DATE"),
    "lead": col("LEAD TEACHER(S)"), "enr_stat": col("ENROLLMENT STAT"), "program": col("PROGRAM"),
    "schedule": col("DAILY SCHEDULE"), "prog_name": col("PROGRAM NAME"), "start": col("INITIAL START DATE"),
    "grad": col("GRADUATION YEAR"), "pay_plan": col("Payment Plan"), "ext_day": col("Extended Day"),
    "ann_tuition": col("Annual Tuition  (NAME CHANGE from Program Tuition)"),
    "organic": col("Organic Lunch"), "months": col("Months Enrolled"),
    "allergy": col("Allergy"), "sus": col("Sus Infection"), "phys_cond": col("Physical Condition"),
    "convuls": col("Convulsions"), "legal": col("Legal Authority"), "custody": col("Physical Custody"),
}

def gv(r, key):
    i = C[key]
    return r[i] if (i >= 0 and i < len(r)) else None

students = [r for r in rows[2:] if r and r[C["last"]]]

# ── connect ─────────────────────────────────────────────────────────
conn = psycopg2.connect(db_url())
cur = conn.cursor()

# existing students by unique_id
cur.execute("SELECT id, family_id, metadata FROM students WHERE school_id=%s", (SCHOOL_ID,))
existing = {}
for sid, fam, meta in cur.fetchall():
    uid = (meta or {}).get("unique_id")
    if uid: existing[str(uid)] = {"id": sid, "family_id": fam, "metadata": meta or {}}

# household_id -> existing family_id (first seen)
cur.execute("""SELECT s.metadata->>'household_id' hh, s.family_id
               FROM students s WHERE s.school_id=%s AND s.metadata ? 'household_id'""", (SCHOOL_ID,))
hh_to_family = {}
for hh, fam in cur.fetchall():
    if hh and hh not in hh_to_family:
        hh_to_family[hh] = fam

# classroom name -> id
cur.execute("SELECT id, name FROM classrooms WHERE school_id=%s", (SCHOOL_ID,))
classroom_by_name = {name.strip().lower(): cid for cid, name in cur.fetchall() if name}

def build_metadata(r, prev=None):
    """Map sheet row -> metadata, merged over prev (preserve unmapped keys)."""
    md = dict(prev or {})
    mapped = {
        "unique_id": s(gv(r, "uid")), "household_id": s(gv(r, "hh")),
        "first_name": s(gv(r, "first")), "last_name": s(gv(r, "last")),
        "middle_name": s(gv(r, "middle")), "grade_level": s(gv(r, "grade")),
        "age": s(gv(r, "age")), "language": s(gv(r, "lang")),
        "activeinactive": s(gv(r, "active")), "homeroom": s(gv(r, "homeroom")),
        "lead_teacher": s(gv(r, "lead")), "program": s(gv(r, "program")),
        "program_name": s(gv(r, "prog_name")), "daily_schedule": s(gv(r, "schedule")),
        "enrollment_status": s(gv(r, "enr_stat")), "home_phone": norm_phone(gv(r, "phone")),
        "birth_date": iso_dt(gv(r, "dob")), "initial_start_date": s(gv(r, "start")),
        "graduation_year": s(gv(r, "grad")), "payment_plan": s(gv(r, "pay_plan")),
        "extended_day": s(gv(r, "ext_day")), "program_tuition": s(gv(r, "ann_tuition")),
        "organic_lunch": s(gv(r, "organic")), "months_enrolled": s(gv(r, "months")),
        "allergy": s(gv(r, "allergy")), "susceptible_infection": s(gv(r, "sus")),
        "physical_condition": s(gv(r, "phys_cond")), "convulsions": s(gv(r, "convuls")),
        "legal_authority": s(gv(r, "legal")), "physical_custody": s(gv(r, "custody")),
    }
    for k, v in mapped.items():
        if v is not None:
            md[k] = v
    return md

# ── plan ────────────────────────────────────────────────────────────
matched, new = [], []
for r in students:
    uid = s(gv(r, "uid"))
    if uid in existing:
        matched.append((uid, r))
    else:
        new.append((uid, r))

print(f"=== DGM roster import {'(APPLY)' if APPLY else '(DRY-RUN)'} ===")
print(f"sheet students: {len(students)}  matched: {len(matched)}  new: {len(new)}")
print(f"DB students not in sheet (untouched): {len(existing) - len(matched)}")
print()

# ── matched updates ─────────────────────────────────────────────────
upd_count = 0
for uid, r in matched:
    ex = existing[uid]
    new_md = build_metadata(r, ex["metadata"])
    first, last = s(gv(r, "first")), s(gv(r, "last"))
    dob = dob_date(gv(r, "dob"))
    gender = s(gv(r, "gender"))
    allergy = s(gv(r, "allergy"))
    if APPLY:
        cur.execute("""UPDATE students SET first_name=COALESCE(%s,first_name),
                         last_name=COALESCE(%s,last_name),
                         date_of_birth=COALESCE(%s,date_of_birth),
                         gender=COALESCE(%s,gender),
                         metadata=%s::jsonb, updated_at=now()
                       WHERE id=%s""",
                    (first, last, dob, gender, json.dumps(new_md), ex["id"]))
        # upsert allergies into health profile
        if allergy:
            cur.execute("""INSERT INTO student_health_profiles (school_id, student_id, allergies)
                           VALUES (%s,%s,%s)
                           ON CONFLICT (school_id, student_id) DO UPDATE SET allergies=EXCLUDED.allergies, updated_at=now()""",
                        (SCHOOL_ID, ex["id"], allergy))
    upd_count += 1
print(f"matched: would update {upd_count} students" if not APPLY else f"matched: updated {upd_count} students")

# ── new students ────────────────────────────────────────────────────
fam_created = 0
fam_reused = 0
stu_created = 0
par_created = 0
new_fam_cache = {}  # household_id -> family_id (created this run)
for uid, r in new:
    hh = s(gv(r, "hh"))
    last = s(gv(r, "last")); first = s(gv(r, "first"))
    # resolve family: existing by household, else created-this-run, else new
    fam_id = hh_to_family.get(hh) or new_fam_cache.get(hh)
    is_new_family = fam_id is None
    if is_new_family:
        display = f"{last} Family"
        if APPLY:
            cur.execute("""INSERT INTO families (school_id, display_name, status)
                           VALUES (%s,%s,'active') RETURNING id""", (SCHOOL_ID, display))
            fam_id = cur.fetchone()[0]
        else:
            fam_id = f"<new-family:{hh}>"
        if hh: new_fam_cache[hh] = fam_id
        fam_created += 1
        # parents from PARENT/GUARDIAN (only for brand-new families)
        parents = parse_parents(gv(r, "parent"))
        phone = norm_phone(gv(r, "phone"))
        for idx, (pf, pl) in enumerate(parents):
            if APPLY:
                cur.execute("""INSERT INTO parents (family_id, school_id, first_name, last_name, phone, role, is_primary, status)
                               VALUES (%s,%s,%s,%s,%s,'parent',%s,'active')""",
                            (fam_id, SCHOOL_ID, pf, pl, phone, idx == 0))
            par_created += 1
    else:
        fam_reused += 1
    # student
    md = build_metadata(r)
    dob = dob_date(gv(r, "dob")); gender = s(gv(r, "gender"))
    classroom_id = classroom_by_name.get((s(gv(r, "homeroom")) or "").lower())
    if APPLY:
        cur.execute("""INSERT INTO students (family_id, school_id, first_name, last_name, date_of_birth, gender, status, metadata)
                       VALUES (%s,%s,%s,%s,%s,%s,'active',%s::jsonb) RETURNING id""",
                    (fam_id, SCHOOL_ID, first, last, dob, gender, json.dumps(md)))
        new_sid = cur.fetchone()[0]
        cur.execute("""INSERT INTO enrollments (student_id, school_id, classroom_id, academic_year, status, schedule, enrolled_at, metadata)
                       VALUES (%s,%s,%s,%s,'enrolled',%s, now(), '{}'::jsonb)""",
                    (new_sid, SCHOOL_ID, classroom_id, ACADEMIC_YEAR, s(gv(r, "schedule"))))
        allergy = s(gv(r, "allergy"))
        if allergy:
            cur.execute("""INSERT INTO student_health_profiles (school_id, student_id, allergies)
                           VALUES (%s,%s,%s) ON CONFLICT (school_id, student_id) DO UPDATE SET allergies=EXCLUDED.allergies""",
                        (SCHOOL_ID, new_sid, allergy))
    stu_created += 1

print(f"new: would create {stu_created} students, {fam_created} families ({fam_reused} attach to existing family), {par_created} parents"
      if not APPLY else
      f"new: created {stu_created} students, {fam_created} families ({fam_reused} attached to existing), {par_created} parents")

# sample of the new students for eyeballing
print("\nsample NEW students:")
for uid, r in new[:12]:
    hh = s(gv(r, "hh"))
    fam_state = "existing-family" if hh_to_family.get(hh) else "NEW-family"
    print(f"  {s(gv(r,'first'))} {s(gv(r,'last'))} · grade {s(gv(r,'grade'))} · {s(gv(r,'homeroom'))} · hh={hh} ({fam_state}) · parents='{s(gv(r,'parent'))}'")

if APPLY:
    conn.commit()
    print("\nCOMMITTED.")
else:
    conn.rollback()
    print("\nDRY-RUN — nothing written. Re-run with --apply to write.")
cur.close(); conn.close()
