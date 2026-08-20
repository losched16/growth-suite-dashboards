// GET /api/export/form-responses/{locationId}?form_id=…[&embed_token=…]
//
// Full answer data for one form's submissions as CSV (Sonia: "Forms
// with full data exportable"). One row per real submission (tests
// excluded), one column per answerable field in the form's CURRENT
// schema (labels as headers, keys as fallback), preceded by
// family/student/parent/status/date columns. Answers not in the current
// schema (renamed/removed fields) are appended as raw-key columns so
// nothing a parent typed is ever silently dropped from the export.

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeExport, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp } from '@/lib/exports/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const formId = (request.nextUrl.searchParams.get('form_id') ?? '').trim();
  if (!formId) return unauthorizedCsvResponse();

  const { rows: defRows } = await query<{
    slug: string; display_name: string;
    field_schema: Array<{ key?: string; label?: string; type?: string }>;
  }>(
    `SELECT slug, display_name, field_schema FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (defRows.length === 0) return unauthorizedCsvResponse();
  const def = defRows[0];

  const DISPLAY_ONLY = new Set(['header', 'paragraph', 'section', 'signature_stamp']);
  const answerable = (Array.isArray(def.field_schema) ? def.field_schema : [])
    .filter((b) => b && typeof b.key === 'string' && b.key && !DISPLAY_ONLY.has(String(b.type ?? '')));
  const fieldKeys = answerable.map((b) => String(b.key));
  // Header = label (key) — labels repeat across sections sometimes, so the
  // key keeps columns unambiguous for Excel pivoting.
  const fieldHeaders = answerable.map((b) => (b.label ? `${b.label} (${b.key})` : String(b.key)));

  const { rows: subs } = await query<{
    submitted_at: string; status: string; is_addendum: boolean;
    family_label: string; student_label: string | null;
    parent_email: string | null; responses: Record<string, unknown>;
  }>(
    `SELECT to_char(s.submitted_at AT TIME ZONE 'America/Phoenix', 'YYYY-MM-DD HH24:MI') AS submitted_at,
            s.status, COALESCE(s.is_addendum, false) AS is_addendum,
            COALESCE(NULLIF(f.display_name, ''),
                     NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), ''),
                     s.submitter_email, '(unnamed family)') AS family_label,
            CASE WHEN st.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                 ELSE NULL END AS student_label,
            COALESCE(p.email, s.submitter_email) AS parent_email,
            s.responses
       FROM portal_form_submissions s
       LEFT JOIN families f ON f.id = s.family_id
       LEFT JOIN parents p ON p.id = s.parent_id
       LEFT JOIN students st ON st.id = s.student_id
      WHERE s.form_definition_id = $1
        AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        AND COALESCE(s.is_test, false) = false
      ORDER BY s.submitted_at ASC`,
    [formId],
  );

  // Answers whose keys aren't in the current schema (field renamed or
  // removed after submissions came in) — appended so data never vanishes.
  const known = new Set(fieldKeys);
  const extraKeys: string[] = [];
  for (const s of subs) {
    for (const k of Object.keys(s.responses ?? {})) {
      if (!known.has(k) && !extraKeys.includes(k) && !k.endsWith('_signed_at')) extraKeys.push(k);
    }
  }

  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map(String).join('; ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  type Row = Record<string, string>;
  const rows: Row[] = subs.map((s) => {
    const r: Row = {
      submitted: s.submitted_at,
      family: s.family_label,
      student: s.student_label ?? '',
      parent_email: s.parent_email ?? '',
      status: s.status,
      amendment: s.is_addendum ? 'Yes' : '',
    };
    fieldKeys.forEach((k, i) => { r[`f_${i}`] = fmt(s.responses?.[k]); });
    extraKeys.forEach((k, i) => { r[`x_${i}`] = fmt(s.responses?.[k]); });
    return r;
  });
  const columns = [
    { key: 'submitted', label: 'Submitted' },
    { key: 'family', label: 'Family' },
    { key: 'student', label: 'Student' },
    { key: 'parent_email', label: 'Parent email' },
    { key: 'status', label: 'Status' },
    { key: 'amendment', label: 'Amendment' },
    ...fieldKeys.map((_, i) => ({ key: `f_${i}`, label: fieldHeaders[i] })),
    ...extraKeys.map((k, i) => ({ key: `x_${i}`, label: k })),
  ];

  return csvResponse(`${def.slug}-responses-${dateStamp()}.csv`, toCsv(rows, columns));
}
