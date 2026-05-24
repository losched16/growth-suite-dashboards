-- DonorPerfect import schema. Source of truth for the Donors dashboard.
--
-- Import flow: operator drops the 2 DP exports (Bio + Gifts) at
-- scripts/import-donor-perfect.py. Bio is the donor master (one row per
-- DONOR_ID); Gifts is the transactional ledger (one row per GIFT_ID).
-- Each donor row gets matched against family-graph parents by email
-- (lowercased) then by name — populating matched_family_id when the
-- donor is also a current or former parent.
--
-- Snapshot semantics: re-running the import DELETEs all dp_donors /
-- dp_gifts for the school then re-INSERTs. Manual tags on donor_tags
-- survive across imports because the table keys on dp_donor_id which
-- is itself keyed on (school_id, dp_donor_id) — preserved by the
-- importer with a carry-forward map.

CREATE TABLE IF NOT EXISTS dp_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- DonorPerfect's primary key (numeric in DP, kept as text for safety).
  dp_donor_id text NOT NULL,

  -- Org flag: 'Y' = organization/business, 'N' = individual.
  org_rec text,

  -- Name / salutation
  title text,
  first_name text,
  last_name text,
  suffix text,
  prof_title text,
  salutation text,
  opt_line text,

  -- Address
  address text,
  address2 text,
  city text,
  state text,
  state_descr text,
  zip text,

  -- Contact
  email text,
  email_lower text,                   -- precomputed for matching
  mobile_phone text,
  home_phone text,
  business_phone text,

  -- Lifetime aggregates as exported by DP. Authoritative numbers (for
  -- per-year breakdowns) are computed from dp_gifts; these are kept so
  -- we don't need to re-aggregate for the lifetime view.
  gift_total numeric(12, 2) DEFAULT 0,
  ly_cytd numeric(12, 2) DEFAULT 0,   -- DP's "last year cumulative YTD"
  gifts_count int DEFAULT 0,

  -- Narrative + free-text fields
  additional_notes text,
  vol_additional text,
  linkedin text,
  facebook text,
  social_media text,

  -- Inferred segment at import time. Surface in the directory for
  -- one-click filtering.
  --   'business'        ORG_REC = Y
  --   'current_family'  matched to a family with at least one active student
  --   'alumni_family'   matched to a family but no active students
  --   'individual'      not an org, no family match
  inferred_segment text,

  -- Family-graph link
  matched_family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  matched_parent_id uuid REFERENCES parents(id) ON DELETE SET NULL,
  match_method text,                  -- 'by_email' / 'by_name' / 'unmatched'

  imported_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, dp_donor_id)
);

CREATE INDEX IF NOT EXISTS idx_dp_donors_school ON dp_donors (school_id);
CREATE INDEX IF NOT EXISTS idx_dp_donors_school_segment
  ON dp_donors (school_id, inferred_segment);
CREATE INDEX IF NOT EXISTS idx_dp_donors_email_lower
  ON dp_donors (school_id, email_lower)
  WHERE email_lower IS NOT NULL AND email_lower <> '';
CREATE INDEX IF NOT EXISTS idx_dp_donors_family
  ON dp_donors (matched_family_id) WHERE matched_family_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dp_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,

  -- DonorPerfect gift PK
  dp_gift_id text NOT NULL,
  dp_donor_id text NOT NULL,

  -- Snapshot of donor identity at gift time (denormalized in DP export)
  donor_first_name text,
  donor_last_name text,
  donor_email text,

  gift_date date,
  amount numeric(12, 2) DEFAULT 0,

  -- Cross-link to the donor row in our table (uuid). Convenience for
  -- widget queries — same school_id + dp_donor_id pair on dp_donors.
  donor_uuid uuid REFERENCES dp_donors(id) ON DELETE SET NULL,

  imported_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (school_id, dp_gift_id)
);

CREATE INDEX IF NOT EXISTS idx_dp_gifts_school ON dp_gifts (school_id);
CREATE INDEX IF NOT EXISTS idx_dp_gifts_donor
  ON dp_gifts (school_id, dp_donor_id);
CREATE INDEX IF NOT EXISTS idx_dp_gifts_school_date
  ON dp_gifts (school_id, gift_date);

-- Operator-applied tags. One row per (donor, tag) pair so a donor can be
-- both a "sponsor" and a "local_partner". Tags survive re-imports
-- because they key on dp_donor_id (not the uuid which gets regenerated
-- by snapshot deletes).
--
-- Suggested tag keys (operator can add ad-hoc but these are the seeded
-- ones surfaced in the directory filter): sponsor, local_partner,
-- hr_parent, top_donor (manual override), volunteer_event,
-- volunteer_classroom, volunteer_athletics.
CREATE TABLE IF NOT EXISTS donor_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  dp_donor_id text NOT NULL,
  tag text NOT NULL,                  -- snake_case slug
  note text,                          -- optional context per tag
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, dp_donor_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_donor_tags_school_tag
  ON donor_tags (school_id, tag);
CREATE INDEX IF NOT EXISTS idx_donor_tags_donor
  ON donor_tags (school_id, dp_donor_id);
