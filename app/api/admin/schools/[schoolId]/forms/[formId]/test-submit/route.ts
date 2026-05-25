// POST /api/admin/schools/{schoolId}/forms/{formId}/test-submit
//
// Staff-initiated form submission used by the preview's TEST MODE.
//
// What it does:
//   1) Reads multipart form data
//   2) Builds a `responses` JSON from the schema's field keys
//   3) Inserts a portal_form_submissions row with is_test=true
//      (NO file uploads, NO GHL writeback, NO email, NO Stripe — those
//      are reported by the result page in the dry-run "Behind the
//      scenes" panel, not executed)
//   4) Returns { id, redirect_to } where redirect_to is the result page
//      inside the school iframe.
//
// Auth: dual (operator OR matching school session) via the standard
// helper. School session must match the schoolId in the URL.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string; formId: string }>;

interface DefRow {
  id: string;
  slug: string;
  display_name: string;
  per_student: boolean;
  field_schema: Array<Record<string, unknown>>;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  // Load definition + validate ownership
  const { rows: defRows } = await query<DefRow>(
    `SELECT id, slug, display_name, per_student, field_schema
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (defRows.length === 0) {
    return NextResponse.json({ error: 'form_not_found' }, { status: 404 });
  }
  const def = defRows[0];

  // Build `responses` JSON from form-data fields. We walk the schema
  // so we only persist keys the schema knows about (avoids garbage
  // from unrelated form-data entries).
  const responses: Record<string, unknown> = {};
  const skippedFileFields: string[] = [];
  const blocks = Array.isArray(def.field_schema) ? def.field_schema : [];
  for (const block of blocks) {
    const key = String(block.key ?? '').trim();
    if (!key) continue;
    const type = String(block.type ?? '');

    if (type === 'file_upload') {
      // Test mode skips file storage — note it for the dry-run report.
      const file = fd.get(key);
      if (file && typeof file !== 'string' && 'name' in file) {
        skippedFileFields.push(key);
      }
      continue;
    }
    if (type === 'multi_checkbox') {
      // FormData.getAll returns an array of all values with this name.
      const values = fd.getAll(key).map((v) => String(v));
      if (values.length > 0) responses[key] = values;
      continue;
    }
    if (type === 'checkbox') {
      // Checkbox is present when checked, missing when not.
      responses[key] = fd.has(key);
      continue;
    }
    // Default — last value wins for everything else.
    const v = fd.get(key);
    if (v != null) responses[key] = typeof v === 'string' ? v : String(v);
  }

  // Persist the test submission. status='submitted' so it shows up
  // exactly like a real one when the inbox toggle is on. family_id /
  // parent_id are NULL (per migration 041 the CHECK constraint
  // allows this only when is_test=true).
  const submissionMeta = {
    skipped_files: skippedFileFields,
    actor: 'preview-test@growth-suite',
  };
  const responsesWithMeta = { ...responses, __test_meta__: submissionMeta };
  const ins = await query<{ id: string }>(
    `INSERT INTO portal_form_submissions
       (school_id, form_definition_id, family_id, parent_id, student_id,
        responses, status, submitted_at, is_test)
     VALUES ($1, $2, NULL, NULL, NULL,
             $3::jsonb, 'submitted', now(), true)
     RETURNING id`,
    [schoolId, formId, JSON.stringify(responsesWithMeta)],
  );
  const submissionId = ins.rows[0].id;

  // Resolve the school's locationId for the in-iframe result URL. The
  // request originated from a /school/<locationId>/... or /admin/...
  // page; we always send the user to the school result page since
  // that's the one inside the iframe.
  const { rows: schoolRows } = await query<{ ghl_location_id: string }>(
    `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  const locationId = schoolRows[0]?.ghl_location_id;
  if (!locationId) {
    // Shouldn't happen — schools always have a ghl_location_id — but
    // fall back gracefully so we don't 500 on the test path.
    return NextResponse.json({
      id: submissionId,
      redirect_to: `/admin/${schoolId}/forms/${formId}/preview?msg=Test+submission+stored`,
    });
  }
  const resultUrl = `/school/${locationId}/forms/${formId}/preview/result?submission=${submissionId}&chrome=none`;
  return NextResponse.json({ id: submissionId, redirect_to: resultUrl });
}
