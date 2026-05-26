-- 044_menus_and_categories.sql
--
-- Two unrelated school-level features that share a release window:
--
-- 1) school_menu_assets    — per-school uploadable menu images
--                            (lunch-calendar / snack-menu / harvest).
--                            Replaces the static /public/dgm-menus/*.png
--                            with a DB-backed CMS designated staff can
--                            edit without a redeploy.
-- 2) school_menu_editors   — allowlist of teacher emails permitted to
--                            upload new menu images. Managed by the
--                            operator via /admin/[schoolId]/menu-editors.
-- 3) school_document_categories — per-school custom category list for
--                            student_documents uploads. Lets each
--                            school define its own taxonomy instead of
--                            the hardcoded health/iep/transcript/other.
--                            Removes the "other" catch-all by default.

BEGIN;

-- ── Menu assets ────────────────────────────────────────────────────
-- One row per (school, slot). Slots are fixed today (lunch-calendar /
-- snack-menu / harvest) but the column is text so new slots can be
-- added by other schools later without a migration. Latest write wins
-- — we only keep the current image per slot. Past images are gone on
-- the next upload.
CREATE TABLE IF NOT EXISTS school_menu_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  slot              text NOT NULL,
  display_label     text,                    -- "Monthly Lunch Calendar" — optional override
  original_filename text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 15 * 1024 * 1024),
  contents          bytea NOT NULL,
  uploaded_by       text,                    -- email from the teacher cookie
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_menu_assets_school_slot UNIQUE (school_id, slot)
);

CREATE INDEX IF NOT EXISTS school_menu_assets_school_idx ON school_menu_assets(school_id);

COMMENT ON TABLE school_menu_assets IS
  'Latest menu image per (school, slot). Replaces /public/dgm-menus PNGs once any school uploads via the CMS.';

-- ── Menu editor allowlist ──────────────────────────────────────────
-- Emails permitted to upload menu images for a given school.
-- Maintained by the operator via /admin/[schoolId]/menu-editors.
CREATE TABLE IF NOT EXISTS school_menu_editors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text,                          -- display name for the admin UI
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_menu_editors_unique UNIQUE (school_id, email)
);

CREATE INDEX IF NOT EXISTS school_menu_editors_school_idx ON school_menu_editors(school_id);

COMMENT ON TABLE school_menu_editors IS
  'Emails permitted to upload menu images. Managed by the operator per-school.';

-- ── School document categories ────────────────────────────────────
-- Per-school taxonomy for student_documents.category. When a row
-- exists for a school, the upload endpoint requires the category to
-- match (case-insensitive); otherwise it falls back to the legacy
-- hardcoded list.
--
-- "other" is intentionally NOT seeded — DGM (and most schools) want
-- specific categories so the document browser is useful at scan-time.
CREATE TABLE IF NOT EXISTS school_document_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  key         text NOT NULL,                 -- machine slug: 'iep', 'custody_order'
  label       text NOT NULL,                 -- display: 'IEP', 'Custody order'
  sort_order  integer NOT NULL DEFAULT 100,
  created_by  text,                          -- email of whoever created it
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_document_categories_unique UNIQUE (school_id, key)
);

CREATE INDEX IF NOT EXISTS school_document_categories_school_idx ON school_document_categories(school_id);

COMMENT ON TABLE school_document_categories IS
  'Per-school custom category list for student_documents. Replaces the hardcoded health/iep/transcript/other array once any rows exist.';

COMMIT;
