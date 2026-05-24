"""
One-off importer for DonorPerfect CSV exports into the platform DB.

Usage:
    DATABASE_URL=postgres://... python scripts/import-donor-perfect.py \
        --school-id <uuid> \
        --bio   "DPBio2026(in).csv" \
        --gifts "DPGifts2026(in).csv"

What it does:
  1. Reads both CSVs (UTF-8, treats `?` and blank as null where useful).
  2. Dedupes Bio by DONOR_ID — picks the most-populated row per donor
     (some DP exports include historical address rows under the same ID).
  3. Matches each donor to a family-graph parent by email-lowered first,
     then name fallback. Populates matched_family_id + matched_parent_id.
  4. Computes inferred_segment per donor:
        business        ORG_REC = Y
        current_family  family has at least one active student
        alumni_family   family exists but no active students
        individual      otherwise
  5. DELETEs all dp_donors / dp_gifts for the school, then INSERTs fresh
     rows. donor_tags is NOT touched — manual tags survive re-imports.
  6. Re-links dp_gifts.donor_uuid to the new dp_donors row by
     (school_id, dp_donor_id).

Prints match stats at the end so the operator can verify quality.
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


def clean_text(v):
    """Pandas → text. Treats NaN, '?', and empty as None."""
    if v is None or pd.isna(v):
        return None
    s = str(v).strip()
    if not s or s == "?" or s == "nan":
        return None
    return s


def clean_email(v):
    """Lowercase + strip; drop obviously bogus values."""
    s = clean_text(v)
    if not s:
        return None
    s = s.lower()
    # Reject anything that doesn't look like an email
    if "@" not in s or "." not in s.split("@", 1)[1]:
        return None
    return s


def parse_money(v):
    """'$7,460.00 ' → 7460.00 ; empty / NaN → 0.0"""
    if v is None or pd.isna(v):
        return 0.0
    s = str(v).strip()
    if not s:
        return 0.0
    # Strip currency symbols, commas, whitespace, parens (negatives)
    neg = s.startswith("(") and s.endswith(")")
    s = re.sub(r"[\$,\s]", "", s)
    s = s.strip("()")
    try:
        n = float(s)
    except (ValueError, TypeError):
        return 0.0
    return -n if neg else n


def parse_int(v):
    if v is None or pd.isna(v):
        return 0
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def parse_date(v):
    """Multiple DP formats — best-effort, returns ISO YYYY-MM-DD or None."""
    if v is None or pd.isna(v):
        return None
    s = str(v).strip()
    if not s:
        return None
    # Try common formats DP uses
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return pd.to_datetime(s, format=fmt).date().isoformat()
        except (ValueError, TypeError):
            continue
    try:
        return pd.to_datetime(s).date().isoformat()
    except (ValueError, TypeError):
        return None


def pick_best_bio_row(rows):
    """When DONOR_ID appears multiple times in Bio, pick the row with the
    most populated fields (highest count of non-null important cols).
    Ties broken by row order (later wins)."""
    important = ["EMAIL", "ADDRESS", "ADDRESS2", "CITY", "ZIP", "MOBILE_PHONE",
                 "HOME_PHONE", "BUSINESS_PHONE", "FIRST_NAME", "LAST_NAME"]
    best = None
    best_score = -1
    for r in rows:
        score = sum(1 for c in important if clean_text(r.get(c)))
        if score >= best_score:
            best = r
            best_score = score
    return best


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--school-id", required=True)
    p.add_argument("--bio", required=True, help="DonorPerfect Bio CSV")
    p.add_argument("--gifts", required=True, help="DonorPerfect Gifts CSV")
    args = p.parse_args()

    db = os.environ.get("DATABASE_URL")
    if not db:
        sys.exit("DATABASE_URL env var required")

    print(f"reading {args.bio}")
    df_bio = pd.read_csv(args.bio, dtype=str, keep_default_na=False, na_values=[""])
    print(f"  {len(df_bio)} bio rows (incl. duplicates)")

    print(f"reading {args.gifts}")
    df_gifts = pd.read_csv(args.gifts, dtype=str, keep_default_na=False, na_values=[""])
    print(f"  {len(df_gifts)} gift rows")

    conn = psycopg2.connect(db)
    conn.autocommit = False
    cur = conn.cursor()

    # ---- Load family-graph for matching ----------------------------------
    cur.execute(
        """SELECT id, family_id, first_name, last_name, LOWER(email),
                  is_primary
           FROM parents
           WHERE school_id = %s AND status = 'active'""",
        (args.school_id,),
    )
    parent_rows = cur.fetchall()
    parent_by_email = {}             # email_lower -> (parent_id, family_id)
    parent_by_name = {}              # (last_norm, first_norm) -> (parent_id, family_id)
    for pid, fid, pfn, pln, pem, _is_primary in parent_rows:
        if pem and pem.strip():
            parent_by_email.setdefault(pem.strip(), (pid, fid))
        key = (norm(pln), norm(pfn))
        parent_by_name.setdefault(key, (pid, fid))

    # Families with at least one active student (for current/alumni split)
    cur.execute(
        """SELECT DISTINCT family_id FROM students
           WHERE school_id = %s AND status = 'active'""",
        (args.school_id,),
    )
    families_with_active_students = {row[0] for row in cur.fetchall()}

    print(f"family-graph: {len(parent_rows)} parents, "
          f"{len(parent_by_email)} unique emails, "
          f"{len(families_with_active_students)} families with active students")

    # ---- Dedupe Bio by DONOR_ID ------------------------------------------
    bio_by_id = {}
    for _, r in df_bio.iterrows():
        did = clean_text(r.get("DONOR_ID"))
        if not did:
            continue
        bio_by_id.setdefault(did, []).append(r)
    print(f"unique donors after dedupe: {len(bio_by_id)}")

    # ---- Build donor rows -------------------------------------------------
    donor_rows = []
    stats = {
        "matched_by_email": 0,
        "matched_by_name": 0,
        "unmatched": 0,
        "business": 0,
        "current_family": 0,
        "alumni_family": 0,
        "individual": 0,
    }

    for did, rows in bio_by_id.items():
        r = pick_best_bio_row(rows)

        org_rec = (clean_text(r.get("ORG_REC")) or "N").upper()
        first_name = clean_text(r.get("FIRST_NAME"))
        last_name = clean_text(r.get("LAST_NAME"))
        email = clean_email(r.get("EMAIL"))

        # Match
        matched_parent_id, matched_family_id, method = None, None, "unmatched"
        if email and email in parent_by_email:
            matched_parent_id, matched_family_id = parent_by_email[email]
            method = "by_email"
            stats["matched_by_email"] += 1
        else:
            key = (norm(last_name), norm(first_name))
            if key[0] and key[1] and key in parent_by_name:
                matched_parent_id, matched_family_id = parent_by_name[key]
                method = "by_name"
                stats["matched_by_name"] += 1
            else:
                stats["unmatched"] += 1

        # Segment
        if org_rec == "Y":
            segment = "business"
        elif matched_family_id is not None:
            if matched_family_id in families_with_active_students:
                segment = "current_family"
            else:
                segment = "alumni_family"
        else:
            segment = "individual"
        stats[segment] += 1

        donor_rows.append((
            args.school_id,
            did,
            org_rec,
            clean_text(r.get("TITLE")),
            first_name,
            last_name,
            clean_text(r.get("SUFFIX")),
            clean_text(r.get("PROF_TITLE")),
            clean_text(r.get("SALUTATION")),
            clean_text(r.get("OPT_LINE")),
            clean_text(r.get("ADDRESS")),
            clean_text(r.get("ADDRESS2")),
            clean_text(r.get("CITY")),
            clean_text(r.get("STATE")),
            clean_text(r.get("STATE_DESCR")),
            clean_text(r.get("ZIP")),
            email,                            # raw lowercased email
            email,                            # email_lower (same value)
            clean_text(r.get("MOBILE_PHONE")),
            clean_text(r.get("HOME_PHONE")),
            clean_text(r.get("BUSINESS_PHONE")),
            parse_money(r.get("GIFT_TOTAL")),
            parse_money(r.get("LY_CYTD")),
            parse_int(r.get("GIFTS")),
            clean_text(r.get("ADDITIONAL_NOTES")),
            clean_text(r.get("VOL_ADDITIONAL")),
            clean_text(r.get("LINKEDIN")),
            clean_text(r.get("FACEBOOK")),
            clean_text(r.get("SOCIAL_MEDIA")),
            segment,
            matched_family_id,
            matched_parent_id,
            method,
        ))

    # ---- Build gift rows --------------------------------------------------
    gift_rows = []
    gift_unmatched_donor = 0
    for _, r in df_gifts.iterrows():
        gid = clean_text(r.get("GIFT_ID"))
        did = clean_text(r.get("DONOR_ID"))
        if not gid or not did:
            continue
        if did not in bio_by_id:
            gift_unmatched_donor += 1  # gift references a donor missing from Bio
        gift_rows.append((
            args.school_id,
            gid,
            did,
            clean_text(r.get("first_name")),
            clean_text(r.get("last_name")),
            clean_email(r.get("email")),
            parse_date(r.get("GIFT_DATE")),
            parse_money(r.get("AMOUNT")),
        ))

    # ---- Snapshot DELETE then INSERT --------------------------------------
    #
    # Preserve operator-edited school_notes across the snapshot. The full
    # re-import wipes dp_donors and rebuilds from the CSV — that's a feature
    # for bio/aggregate columns but it would destroy free-form notes the
    # school's team typed in via the Donors dashboard. We snapshot them
    # before delete, then restore by dp_donor_id after the insert.
    print()
    print("=== Writing to DB ===")
    cur.execute(
        """SELECT dp_donor_id, school_notes, school_notes_updated_at, school_notes_updated_by
             FROM dp_donors
            WHERE school_id = %s AND school_notes IS NOT NULL""",
        (args.school_id,),
    )
    preserved_notes = list(cur.fetchall())
    if preserved_notes:
        print(f"  preserving school_notes on {len(preserved_notes)} donor(s) across re-import")
    cur.execute("DELETE FROM dp_gifts WHERE school_id = %s", (args.school_id,))
    cur.execute("DELETE FROM dp_donors WHERE school_id = %s", (args.school_id,))

    execute_values(
        cur,
        """INSERT INTO dp_donors (
            school_id, dp_donor_id, org_rec,
            title, first_name, last_name, suffix, prof_title, salutation, opt_line,
            address, address2, city, state, state_descr, zip,
            email, email_lower,
            mobile_phone, home_phone, business_phone,
            gift_total, ly_cytd, gifts_count,
            additional_notes, vol_additional, linkedin, facebook, social_media,
            inferred_segment, matched_family_id, matched_parent_id, match_method
           ) VALUES %s""",
        donor_rows,
    )
    print(f"inserted {len(donor_rows)} donors")

    # Restore school_notes from the pre-delete snapshot. Iterates row by
    # row — small lists (typically a handful per school) so this is
    # cheap even without batching.
    if preserved_notes:
        restored = 0
        for dp_donor_id, sn, sn_at, sn_by in preserved_notes:
            cur.execute(
                """UPDATE dp_donors
                      SET school_notes = %s,
                          school_notes_updated_at = %s,
                          school_notes_updated_by = %s
                    WHERE school_id = %s AND dp_donor_id = %s""",
                (sn, sn_at, sn_by, args.school_id, dp_donor_id),
            )
            if cur.rowcount > 0:
                restored += 1
        print(f"restored school_notes on {restored} donor(s)")

    execute_values(
        cur,
        """INSERT INTO dp_gifts (
            school_id, dp_gift_id, dp_donor_id,
            donor_first_name, donor_last_name, donor_email,
            gift_date, amount
           ) VALUES %s""",
        gift_rows,
    )
    print(f"inserted {len(gift_rows)} gifts ({gift_unmatched_donor} gifts reference unknown DONOR_ID)")

    # Re-link dp_gifts.donor_uuid via (school_id, dp_donor_id)
    cur.execute(
        """UPDATE dp_gifts g SET donor_uuid = d.id
           FROM dp_donors d
           WHERE g.school_id = %s AND d.school_id = %s
             AND g.dp_donor_id = d.dp_donor_id""",
        (args.school_id, args.school_id),
    )
    print(f"linked dp_gifts.donor_uuid -> dp_donors.id (rowcount: {cur.rowcount})")

    conn.commit()
    cur.close()
    conn.close()

    print()
    print("=== Match stats ===")
    total = len(donor_rows) or 1
    print(f"  by email:    {stats['matched_by_email']:5}  ({100*stats['matched_by_email']//total}%)")
    print(f"  by name:     {stats['matched_by_name']:5}  ({100*stats['matched_by_name']//total}%)")
    print(f"  unmatched:   {stats['unmatched']:5}  ({100*stats['unmatched']//total}%)")
    print()
    print("=== Inferred segments ===")
    for s in ("business", "current_family", "alumni_family", "individual"):
        print(f"  {s:16} {stats[s]:5}  ({100*stats[s]//total}%)")
    print()
    print("done.")


if __name__ == "__main__":
    main()
