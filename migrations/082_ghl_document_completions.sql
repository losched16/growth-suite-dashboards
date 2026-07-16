-- 082: ledger of GHL Documents & Contracts completions we've processed.
--
-- The documents poller (lib/sync/import-ghl-documents.ts, gated on
-- schools.settings.ghl_documents_sync) lists the location's documents each
-- sync cycle and reacts to status='completed' ones exactly once — this
-- table is the idempotency record. az_field_set marks that the matching
-- per-student tracking field (e.g. Student 2 AZ Card=Complete) was written
-- to the primary contact; imported_pdf is reserved for phase 2 (pulling
-- the signed PDF into student documents once the PIT gets the
-- documents-detail scope).

CREATE TABLE IF NOT EXISTS ghl_document_completions (
  school_id       uuid NOT NULL,
  ghl_document_id text NOT NULL,
  document_name   text NOT NULL,
  ghl_contact_id  text,           -- the signer (may be a P2 contact)
  family_id       uuid,
  student_id      uuid,
  signed_at       timestamptz,
  az_field_set    boolean NOT NULL DEFAULT false,
  imported_pdf    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, ghl_document_id)
);
