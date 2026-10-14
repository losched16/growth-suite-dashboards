// Whole-school "one row per student" report across one or more portal
// forms. Office staff kept rebuilding these by opening every family's
// submission one at a time (Wooster, Oct 2026: "all students and their
// media permissions", "every student with allergies", "each student's
// class-roster permission").
//
// Per student × form, the answer source is the LATEST real submission:
//   per-student form → that student's; per-family form → the family's
// (so every sibling carries the family answer). Later amendments overlay
// the fields they changed. Old imported submissions keep answers under
// `_legacy_answers` ({key,label,value}[]) — matched to the current form by
// key, then by question label; anything that still doesn't match becomes
// its own "(earlier form)" column so no answer silently disappears.
//
// Used by the CSV export (/api/export/student-report) and the bulk print
// page (/school/[locationId]/forms/[formId]/print-all).

import { query } from '@/lib/db';

const DISPLAY_ONLY = new Set(['header', 'paragraph', 'section', 'signature_stamp', 'divider', 'image']);
// Earlier-form (imported) questions that are submission plumbing, not answers.
const LEGACY_SKIP = /signature|^ip$|^e-?mail$|form ?id|timezone|event ?data|session ?id|location ?id|submission ?id|fields ?ori|contact ?id|^(student )?(first|last) name$|^student (first|last) name$/i;
const NEGATIVE = /^(no|none|n\/?a|na|nka|nkda|nothing|not applicable|no known|none known|no allergies|false|0|-+)\b/i;

type Block = { key?: string; label?: string; type?: string; options?: Array<{ value?: unknown; label?: unknown } | string> };
type LegacyAnswer = { key?: string; label?: string; value?: unknown };

export interface ReportForm {
  id: string;
  slug: string;
  name: string;
  perStudent: boolean;
  fields: Array<{ key: string; label: string; type: string; options?: Map<string, string> }>;
}

export interface ReportColumn {
  id: string;            // stable column id (form id + key)
  formId: string;
  label: string;         // header text
  key: string | null;    // schema key (null = earlier-form-only question)
}

export interface ReportStudent {
  studentId: string;
  familyId: string;
  student: string;
  firstName: string;
  lastName: string;
  classroom: string;
  program: string;
  family: string;
  parentName: string;
  parentEmail: string;
  parentPhone: string;
}

export interface ReportRow extends ReportStudent {
  submittedOn: Record<string, string | null>;      // formId → YYYY-MM-DD or null
  submissionId: Record<string, string | null>;     // formId → submission id
  source: Record<string, string>;                  // formId → 'Current form' | 'Earlier form (imported)' | ''
  values: Record<string, string>;                  // column id → value
}

export interface StudentReport {
  forms: ReportForm[];
  columns: ReportColumn[];
  rows: ReportRow[];
  scope: 'enrolled' | 'all';
}

const normLabel = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => formatAnswer(x)).filter(Boolean).join('; ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string' || typeof o.relationship === 'string' || typeof o.phone === 'string') {
      return [o.name, o.relationship, o.phone].filter(Boolean).join(' — ');
    }
    return Object.values(o).map((x) => formatAnswer(x)).filter(Boolean).join('; ');
  }
  const s = String(v);
  if (s.startsWith('data:image')) return '[signature]';
  return s.replace(/\r?\n+/g, ' / ').trim();
}

export function isAffirmative(v: string): boolean {
  const t = v.trim();
  return t !== '' && !NEGATIVE.test(t);
}

export async function buildStudentReport(opts: {
  schoolId: string;
  formIds: string[] | 'all';
  match?: RegExp | null;           // keep only questions whose label/key matches
  flaggedOnly?: boolean;           // keep only students with an affirmative answer in a kept question
  classroom?: string | null;       // exact classroom name filter
  scope?: 'enrolled' | 'all';
}): Promise<StudentReport> {
  const { schoolId } = opts;

  const { rows: defs } = await query<{ id: string; slug: string; display_name: string; per_student: boolean; field_schema: Block[] | null }>(
    `SELECT id, slug, display_name, per_student, field_schema
       FROM portal_form_definitions
      WHERE school_id = $1 AND is_active = true AND audience IS DISTINCT FROM 'staff'
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY display_name`,
    [schoolId, opts.formIds === 'all' ? null : opts.formIds],
  );
  const forms: ReportForm[] = defs.map((d) => ({
    id: d.id, slug: d.slug, name: d.display_name, perStudent: d.per_student,
    fields: (Array.isArray(d.field_schema) ? d.field_schema : [])
      .filter((b) => b && typeof b.key === 'string' && b.key && !DISPLAY_ONLY.has(String(b.type ?? '')))
      .filter((b) => !/^signature|signature$|_signature|signature_date$/.test(String(b.key)) && !/^signature/.test(String(b.type ?? '')))
      .map((b) => {
        // option value → the wording the parent actually saw
        const opts = new Map<string, string>();
        for (const o of Array.isArray(b.options) ? b.options : []) {
          if (typeof o === 'string') continue;
          if (o && o.value != null && o.label != null) opts.set(String(o.value), String(o.label));
        }
        return { key: String(b.key), label: String(b.label ?? b.key), type: String(b.type ?? ''), ...(opts.size ? { options: opts } : {}) };
      }),
  }));

  // Students in scope. 'enrolled' falls back to all active students for
  // schools that don't track enrollment status.
  let scope: 'enrolled' | 'all' = opts.scope ?? 'enrolled';
  if (scope === 'enrolled') {
    const { rows: any } = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM enrollments e JOIN students s ON s.id = e.student_id
        WHERE s.school_id = $1 AND e.status = 'enrolled'`, [schoolId]);
    if ((any[0]?.n ?? 0) === 0) scope = 'all';
  }
  const { rows: studs } = await query<ReportStudent>(
    `SELECT s.id AS "studentId", s.family_id AS "familyId",
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student,
            COALESCE(s.first_name, '') AS "firstName", COALESCE(s.last_name, '') AS "lastName",
            COALESCE(NULLIF(cls.name, ''), NULLIF(s.metadata->>'homeroom', ''), NULLIF(s.metadata->>'program', ''), '') AS classroom,
            COALESCE(s.metadata->>'program', '') AS program,
            COALESCE(NULLIF(f.display_name, ''), '') AS family,
            COALESCE(CONCAT_WS(' ', p.first_name, p.last_name), '') AS "parentName",
            COALESCE(p.email, '') AS "parentEmail",
            COALESCE(p.phone, '') AS "parentPhone"
       FROM students s
       JOIN families f ON f.id = s.family_id
       LEFT JOIN LATERAL (
         SELECT e.classroom_id FROM enrollments e
          WHERE e.student_id = s.id ${scope === 'enrolled' ? "AND e.status = 'enrolled'" : ''}
          ORDER BY e.created_at DESC LIMIT 1
       ) en ON true
       LEFT JOIN classrooms cls ON cls.id = en.classroom_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, email, phone FROM parents
          WHERE family_id = s.family_id AND status = 'active'
          ORDER BY is_primary DESC, created_at LIMIT 1
       ) p ON true
      WHERE s.school_id = $1 AND s.status = 'active'
        ${scope === 'enrolled' ? `AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.status = 'enrolled')` : ''}`,
    [schoolId],
  );
  const students = studs
    .filter((s) => !opts.classroom || s.classroom === opts.classroom)
    .sort((a, b) => a.classroom.localeCompare(b.classroom) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  // All real submissions for these forms, newest first.
  const { rows: subs } = await query<{
    id: string; form_definition_id: string; family_id: string | null; student_id: string | null;
    responses: Record<string, unknown> | null; is_addendum: boolean; addendum_fields: unknown; day: string | null; status: string;
  }>(
    `SELECT id, form_definition_id, family_id, student_id, responses, status,
            COALESCE(is_addendum, false) AS is_addendum, addendum_fields,
            to_char(COALESCE(submitted_at, created_at), 'YYYY-MM-DD') AS day
       FROM portal_form_submissions
      WHERE school_id = $1 AND form_definition_id = ANY($2::uuid[])
        AND status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')
        AND voided_at IS NULL AND COALESCE(is_test, false) = false
      ORDER BY COALESCE(submitted_at, created_at) DESC, created_at DESC`,
    [schoolId, forms.map((f) => f.id)],
  );

  // Resolve each form's answers per owner (student or family): base = newest
  // non-amendment submission; newer amendments overlay their changed keys.
  type Resolved = { id: string; day: string | null; answers: Map<string, unknown>; legacy: LegacyAnswer[]; imported: boolean };
  const resolved = new Map<string, Resolved>(); // `${formId}|${ownerId}`
  const pendingAddenda = new Map<string, typeof subs>();
  for (const s of subs) {
    const form = forms.find((f) => f.id === s.form_definition_id)!;
    const owner = form.perStudent ? s.student_id : s.family_id;
    if (!owner) continue;
    const k = `${form.id}|${owner}`;
    if (resolved.has(k)) continue;
    if (s.is_addendum) { (pendingAddenda.get(k) ?? pendingAddenda.set(k, []).get(k)!).push(s); continue; }
    const r = s.responses ?? {};
    const answers = new Map<string, unknown>(Object.entries(r));
    // amendments newer than this base, oldest first
    for (const a of (pendingAddenda.get(k) ?? []).reverse()) {
      const changed = Array.isArray(a.addendum_fields) ? (a.addendum_fields as string[]) : Object.keys(a.responses ?? {});
      for (const key of changed) if (a.responses && key in a.responses) answers.set(key, a.responses[key]);
    }
    const legacy = Array.isArray(r._legacy_answers) ? (r._legacy_answers as LegacyAnswer[]) : [];
    resolved.set(k, { id: s.id, day: s.day, answers, legacy, imported: s.status === 'legacy_imported' });
  }

  // Columns: schema questions (optionally filtered), then earlier-form-only
  // questions that actually carry answers.
  const columns: ReportColumn[] = [];
  const multi = forms.length > 1;
  const keep = (label: string, key: string) => !opts.match || opts.match.test(label) || opts.match.test(key);
  const legacyCols = new Map<string, ReportColumn>(); // `${formId}|label` → col
  for (const f of forms) {
    for (const fld of f.fields) {
      if (!keep(fld.label, fld.key)) continue;
      columns.push({ id: `${f.id}|${fld.key}`, formId: f.id, key: fld.key, label: multi ? `${f.name}: ${fld.label}` : fld.label });
    }
    const schemaKeys = new Set(f.fields.map((x) => x.key));
    const schemaLabels = new Set(f.fields.map((x) => normLabel(x.label)));
    for (const [k, r] of resolved) {
      if (!k.startsWith(`${f.id}|`)) continue;
      for (const la of r.legacy) {
        if ((la.key && schemaKeys.has(la.key)) || schemaLabels.has(normLabel(la.label))) continue;
        const label = String(la.label ?? la.key ?? '').trim();
        if (!label || LEGACY_SKIP.test(label) || formatAnswer(la.value) === '' || !keep(label, String(la.key ?? ''))) continue;
        const ck = `${f.id}|${normLabel(label)}`;
        if (!legacyCols.has(ck)) legacyCols.set(ck, { id: `${f.id}|legacy:${normLabel(label)}`, formId: f.id, key: null, label: `${multi ? `${f.name}: ` : ''}${label} (earlier form)` });
      }
    }
  }
  columns.push(...legacyCols.values());
  // With a question filter, forms that contribute no column are noise
  // (their submitted / answered-on columns would just pad the sheet).
  if (opts.match) {
    const used = new Set(columns.map((c) => c.formId));
    forms.splice(0, forms.length, ...forms.filter((f) => used.has(f.id)));
  }

  const rows: ReportRow[] = [];
  for (const st of students) {
    const row: ReportRow = { ...st, submittedOn: {}, submissionId: {}, source: {}, values: {} };
    for (const f of forms) {
      const r = resolved.get(`${f.id}|${f.perStudent ? st.studentId : st.familyId}`);
      row.submittedOn[f.id] = r?.day ?? null;
      row.submissionId[f.id] = r?.id ?? null;
      row.source[f.id] = r ? (r.imported ? 'Earlier form (imported)' : 'Current form') : '';
      if (!r) continue;
      const byKey = new Map(r.legacy.filter((la) => la.key).map((la) => [la.key!, la.value]));
      const byLabel = new Map(r.legacy.map((la) => [normLabel(la.label), la.value]));
      for (const col of columns) {
        if (col.formId !== f.id) continue;
        let v: unknown;
        if (col.key) {
          v = r.answers.get(col.key);
          // a checkbox question answered with nothing ticked is an answer
          if (Array.isArray(v) && v.length === 0 && !r.imported) { row.values[col.id] = 'None selected'; continue; }
          if (formatAnswer(v) === '') v = byKey.get(col.key);
          if (formatAnswer(v) === '') {
            const fld = f.fields.find((x) => x.key === col.key);
            v = fld ? byLabel.get(normLabel(fld.label)) : undefined;
          }
        } else {
          const want = col.id.slice(`${f.id}|legacy:`.length);
          v = byLabel.get(want);
        }
        const opts = col.key ? f.fields.find((x) => x.key === col.key)?.options : undefined;
        if (opts) v = Array.isArray(v) ? v.map((x) => opts.get(String(x)) ?? x) : (typeof v === 'string' && opts.has(v) ? opts.get(v) : v);
        row.values[col.id] = formatAnswer(v);
      }
    }
    if (opts.flaggedOnly && !columns.some((c) => isAffirmative(row.values[c.id] ?? ''))) continue;
    rows.push(row);
  }
  return { forms, columns, rows, scope };
}

// Parse a user-supplied ?match= pattern safely (bounded, case-insensitive).
export function parseMatch(raw: string | null | undefined): RegExp | null | 'invalid' {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.length > 200) return 'invalid';
  try { return new RegExp(s, 'i'); } catch { return 'invalid'; }
}
