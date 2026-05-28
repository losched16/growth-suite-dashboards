-- Split-billing for divorced / separated families.
--
-- Per-enrollment billing shares (one row per parent who pays a portion
-- of that enrollment). When at least one row exists for an enrollment,
-- invoice generation creates N invoices per installment (one per parent
-- share) instead of a single joint invoice. When no rows exist, the
-- existing single-invoice behavior is preserved (full backward compat).
--
-- Same split applies to every invoice category by design — keeps the
-- admin UX simple and matches how most divorce decrees actually read.
-- If a school needs a per-category split later, add a `category` column
-- to this table.
--
-- Privacy: parent_id is enough to route invoices to the right person.
-- The existing `is_private_from_co_parents` flag on parents continues
-- to control whether each parent can see the other's data in the
-- portal — unrelated to billing split.

CREATE TABLE enrollment_billing_shares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  enrollment_id         uuid NOT NULL REFERENCES family_tuition_enrollments(id) ON DELETE CASCADE,
  parent_id             uuid NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
  -- Share expressed as basis points: 10000 = 100%, 5000 = 50%, 7500 = 75%.
  -- Using BP (not float %) keeps the SUM-to-100% constraint exact and
  -- avoids float drift across N invoices.
  share_basis_points    integer NOT NULL CHECK (share_basis_points >= 0 AND share_basis_points <= 10000),
  notes                 text,
  created_at            timestamp with time zone NOT NULL DEFAULT now(),
  updated_at            timestamp with time zone NOT NULL DEFAULT now(),
  -- One row per (enrollment, parent) — each parent can only have one
  -- share row per enrollment. Updating a split = UPDATE, not INSERT.
  UNIQUE (enrollment_id, parent_id)
);

CREATE INDEX idx_ebs_enrollment ON enrollment_billing_shares(enrollment_id);
CREATE INDEX idx_ebs_school     ON enrollment_billing_shares(school_id);
CREATE INDEX idx_ebs_parent     ON enrollment_billing_shares(parent_id);

-- Tag each invoice with the responsible parent, so the parent portal
-- and billing emails can route per-parent without re-deriving from
-- the enrollment shares on every read.
--   NULL = joint invoice (whole family) — current behavior.
--   NOT NULL = this parent owes this invoice. Co-parents don't see it
--              in their portal view.
ALTER TABLE invoices
  ADD COLUMN responsible_parent_id uuid NULL REFERENCES parents(id) ON DELETE SET NULL;

CREATE INDEX idx_invoices_responsible_parent ON invoices(responsible_parent_id);

-- A small denormalization on family_tuition_enrollments: tracks whether
-- a split is configured. Lets the admin UI ask "is this enrollment
-- split-billed?" without a JOIN, and lets the tuition-plan-generator
-- early-out cheaply on the common single-billed case.
ALTER TABLE family_tuition_enrollments
  ADD COLUMN is_split_billed boolean NOT NULL DEFAULT false;

-- Helper: validate shares for an enrollment SUM to exactly 10000 bp
-- (100%) AND every share's parent belongs to the same family as the
-- enrollment. Runs on every INSERT / UPDATE / DELETE of the shares
-- table. Throwing here would block the whole transaction — instead we
-- use a deferred trigger so multi-row updates (e.g. "set Dad to 60%,
-- set Mom to 40%" as two UPDATEs) can complete before validation.
CREATE OR REPLACE FUNCTION validate_enrollment_billing_shares() RETURNS trigger AS $$
DECLARE
  v_enrollment_id uuid;
  v_total_bp integer;
  v_family_id uuid;
  v_wrong_family_count integer;
BEGIN
  -- For DELETE: NEW is null; use OLD's enrollment_id.
  v_enrollment_id := COALESCE(NEW.enrollment_id, OLD.enrollment_id);

  -- If all shares for this enrollment have been deleted, that's fine —
  -- the enrollment reverts to joint billing.
  SELECT COALESCE(SUM(share_basis_points), 0) INTO v_total_bp
    FROM enrollment_billing_shares
   WHERE enrollment_id = v_enrollment_id;
  IF v_total_bp = 0 THEN
    -- Make sure the enrollment's is_split_billed flag is also off.
    UPDATE family_tuition_enrollments
       SET is_split_billed = false, updated_at = now()
     WHERE id = v_enrollment_id;
    RETURN NULL;
  END IF;

  -- Otherwise total must sum to 10000 (100%) exactly.
  IF v_total_bp <> 10000 THEN
    RAISE EXCEPTION 'enrollment_billing_shares for enrollment % must sum to 10000 basis points (100%%); got %', v_enrollment_id, v_total_bp;
  END IF;

  -- Cross-check: every share's parent must belong to the same family
  -- as the enrollment. Catches a paste-the-wrong-uuid mistake early.
  SELECT family_id INTO v_family_id
    FROM family_tuition_enrollments
   WHERE id = v_enrollment_id;
  SELECT count(*) INTO v_wrong_family_count
    FROM enrollment_billing_shares s
    JOIN parents p ON p.id = s.parent_id
   WHERE s.enrollment_id = v_enrollment_id
     AND p.family_id <> v_family_id;
  IF v_wrong_family_count > 0 THEN
    RAISE EXCEPTION 'enrollment_billing_shares for enrollment % references parents not in family %', v_enrollment_id, v_family_id;
  END IF;

  -- Flip the convenience flag on the enrollment.
  UPDATE family_tuition_enrollments
     SET is_split_billed = true, updated_at = now()
   WHERE id = v_enrollment_id
     AND is_split_billed = false;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferred constraint trigger so a multi-row write (e.g. "Dad → 60%,
-- Mom → 40%" as two UPDATEs in one transaction) sees the final state
-- before we validate the sum.
CREATE CONSTRAINT TRIGGER trg_validate_enrollment_billing_shares
  AFTER INSERT OR UPDATE OR DELETE ON enrollment_billing_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_enrollment_billing_shares();

COMMENT ON TABLE enrollment_billing_shares IS
  'Divorce/separation split-billing. When N>=1 rows exist for an enrollment, invoice generation creates one invoice per share instead of one joint family invoice. Shares must sum to 10000 bp (100%). Enforced by deferred trigger.';

COMMENT ON COLUMN invoices.responsible_parent_id IS
  'Set when this invoice was generated from a split-billed enrollment. The parent portal filters invoices by (family_id, responsible_parent_id IS NULL OR responsible_parent_id = me) so each parent only sees their own share. NULL = joint invoice (current default).';

COMMENT ON COLUMN family_tuition_enrollments.is_split_billed IS
  'Denormalization of enrollment_billing_shares — true when N>=1 share rows exist. Maintained by the validate_enrollment_billing_shares trigger; do not write directly.';
