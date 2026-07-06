-- 078: chunked document uploads.
--
-- Vercel caps serverless request bodies at ~4.5MB, so files above that
-- (scanned IEP/504 PDFs are routinely 5-10MB) never reached the upload
-- route — the gateway rejected them. The client now slices big files
-- into ~3MB chunks: the first chunk INSERTs the row with
-- is_complete=false and size_bytes = the declared final size; each
-- following chunk appends to file_bytes; the last one flips
-- is_complete=true after verifying octet_length matches. Readers
-- (list/download/counts) ignore incomplete rows.

ALTER TABLE student_documents
  ADD COLUMN IF NOT EXISTS is_complete boolean NOT NULL DEFAULT true;
