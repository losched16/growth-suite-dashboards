// /school/[locationId]/forms/[formId]/submissions/[submissionId]
//
// Single-submission view. Print-optimized so an admin can save it as
// PDF via the browser's native print dialog (Cmd/Ctrl-P → Save as PDF).
// Renders the signature as a real PNG image, every response field, and
// the family/student/parent header.
//
// Linked from:
//   - /families/<id>/forms (per-family submission drill-down)
//   - the Portal Forms inbox once we point its links here
//   - direct URLs admin can email each other / archive

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Printer, Image as ImageIcon } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import { PrintSubmissionButton } from './PrintSubmissionButton';
import { VoidSubmissionButton } from './VoidSubmissionButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; formId: string; submissionId: string }>;
type SearchParams = Promise<{ print?: string; msg?: string; err?: string }>;

interface FormDef {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  field_schema: Array<{
    type?: string;
    key?: string;
    label?: string;
    text?: string;       // header / paragraph / section
    description?: string;
    options?: Array<{ value: string; label: string }>;
  }>;
}

interface Submission {
  id: string;
  family_id: string | null;
  parent_id: string | null;
  student_id: string | null;
  status: string;
  submitted_at: string;
  responses: Record<string, unknown>;
  is_test: boolean;
  family_display: string | null;
  parent_first: string | null;
  parent_last: string | null;
  parent_email: string | null;
  parent_phone: string | null;
  student_first: string | null;
  student_last: string | null;
  student_preferred: string | null;
  cosign_status: string | null;
  cosign_name: string | null;
  cosign_email: string | null;
  cosign_signature: string | null;
  cosign_signed_at: string | null;
  voided_at: string | null;
  voided_by_admin_email: string | null;
  voided_reason: string | null;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default async function SubmissionDetail({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId, submissionId } = await params;
  const sp = await searchParams;
  const autoPrint = sp.print === '1';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: defRows } = await query<FormDef>(
    `SELECT id, slug, display_name, description, field_schema
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (defRows.length === 0) notFound();
  const def = defRows[0];

  const { rows: subRows } = await query<Submission>(
    `SELECT s.id, s.family_id, s.parent_id, s.student_id,
            COALESCE(s.status, 'submitted') AS status,
            to_char(s.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS submitted_at,
            s.responses,
            COALESCE(s.is_test, false) AS is_test,
            f.display_name AS family_display,
            p.first_name AS parent_first, p.last_name AS parent_last,
            p.email AS parent_email, p.phone AS parent_phone,
            st.first_name AS student_first, st.last_name AS student_last,
            st.preferred_name AS student_preferred,
            s.cosign_status, s.cosign_name, s.cosign_email, s.cosign_signature,
            to_char(s.cosign_signed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS cosign_signed_at,
            to_char(s.voided_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS voided_at,
            s.voided_by_admin_email, s.voided_reason
       FROM portal_form_submissions s
       LEFT JOIN families f ON f.id = s.family_id
       LEFT JOIN parents p ON p.id = s.parent_id
       LEFT JOIN students st ON st.id = s.student_id
      WHERE s.id = $1 AND s.school_id = $2`,
    [submissionId, school.id],
  );
  if (subRows.length === 0) notFound();
  const sub = subRows[0];

  const studentLabel = sub.student_first
    ? `${(sub.student_preferred?.trim() || sub.student_first)} ${sub.student_last ?? ''}`.trim()
    : null;
  const parentLabel = sub.parent_first
    ? `${sub.parent_first} ${sub.parent_last ?? ''}`.trim()
    : null;
  const familyLabel = sub.family_display || (parentLabel ? `${parentLabel.split(' ').slice(-1)[0]} Family` : 'Family');

  // Render-ready list of (label, key, value) tuples — one per field
  // in field_schema, in schema order, so the PDF reads top-to-bottom
  // the same as the form did.
  const blocks = def.field_schema ?? [];

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        {/* Toolbar — hidden in print */}
        <div className="print:hidden flex items-center justify-between mb-3 gap-2 flex-wrap">
          <Link
            href={sub.family_id
              ? `/school/${locationId}/families/${sub.family_id}/forms?chrome=none`
              : `/school/${locationId}/forms/${formId}/submissions?chrome=none`}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </Link>
          <div className="flex items-center gap-2">
            {sub.status !== 'voided' && sub.status !== 'paid' && sub.status !== 'pending_payment' ? (
              <VoidSubmissionButton
                submissionId={sub.id}
                returnTo={`/school/${locationId}/forms/${formId}/submissions/${sub.id}`}
              />
            ) : null}
            <PrintSubmissionButton autoPrint={autoPrint} />
          </div>
        </div>

        {sub.status === 'voided' ? (
          <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 print:border print:border-rose-300">
            <strong>Voided</strong>
            {sub.voided_at ? ` on ${fmtDateTime(sub.voided_at)}` : ''}
            {sub.voided_by_admin_email ? ` by ${sub.voided_by_admin_email}` : ''}
            {sub.voided_reason ? ` — ${sub.voided_reason}` : ''}.
            {' '}This copy no longer counts as completed; the family can fill the form out again.
          </div>
        ) : null}
        {typeof sp.msg === 'string' && sp.msg ? (
          <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 print:hidden">{sp.msg}</div>
        ) : null}
        {typeof sp.err === 'string' && sp.err ? (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 print:hidden">{sp.err}</div>
        ) : null}

        {/* Print-friendly header */}
        <header className="rounded-lg border border-slate-200 bg-white p-5 print:border-0 print:p-0 print:rounded-none mb-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">{def.display_name}</h1>
              {def.description ? (
                <p className="text-xs text-slate-500 mt-0.5">{def.description}</p>
              ) : null}
            </div>
            {sub.is_test ? (
              <span className="rounded bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-900">test submission</span>
            ) : null}
          </div>

          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Field label="Family" value={familyLabel} />
            <Field label="Submitted" value={fmtDateTime(sub.submitted_at)} />
            {studentLabel ? <Field label="Student" value={studentLabel} /> : null}
            {parentLabel ? <Field label="Submitted by" value={parentLabel} /> : null}
            {sub.parent_email ? <Field label="Parent email" value={sub.parent_email} /> : null}
            {sub.parent_phone ? <Field label="Parent phone" value={sub.parent_phone} /> : null}
            <Field label="Submission ID" value={sub.id} mono />
            <Field label="Status" value={sub.status.replace(/_/g, ' ')} />
          </dl>
        </header>

        {/* Second-guardian (co-sign) status + signature */}
        {sub.cosign_status ? (
          <section className={`rounded-lg border p-4 mb-4 ${sub.cosign_status === 'signed' ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
            <h2 className={`text-sm font-semibold uppercase tracking-wide mb-2 ${sub.cosign_status === 'signed' ? 'text-emerald-800' : 'text-amber-800'}`}>
              Second guardian signature
            </h2>
            {sub.cosign_status === 'signed' ? (
              <>
                <p className="text-sm text-emerald-900">✓ Signed by both guardians — fully executed.</p>
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <Field label="Second guardian" value={sub.cosign_name || sub.cosign_email || '—'} />
                  {sub.cosign_signed_at ? <Field label="Signed" value={fmtDateTime(sub.cosign_signed_at)} /> : null}
                </dl>
                {sub.cosign_signature ? (
                  <div className="mt-3">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">2nd signature</div>
                    <div className="text-2xl text-slate-900" style={{ fontFamily: 'var(--font-signature), "Dancing Script", "Brush Script MT", cursive' }}>
                      {sub.cosign_signature}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-amber-900">
                ⏳ Awaiting the second guardian&rsquo;s signature{sub.cosign_name ? ` from ${sub.cosign_name}` : ''}{sub.cosign_email ? ` (${sub.cosign_email})` : ''}.
              </p>
            )}
          </section>
        ) : null}

        {/* Responses */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 print:border-0 print:p-0 print:rounded-none">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3 print:hidden">Responses</h2>
          <div className="space-y-4">
            {blocks
              // Blocks hidden on the live form (e.g. the internal "add a second
              // parent/guardian" toggle when Parent 2 is already on file) stay
              // hidden on the admin view too. hide_on_review additionally hides
              // a field from THIS view/print only (it still shows on the live
              // form) — e.g. section-reveal toggles that are noise on the PDF.
              .filter((block) => (block as { hidden?: boolean }).hidden !== true
                && (block as { hide_on_review?: boolean }).hide_on_review !== true)
              .map((block, i) => (
              <BlockView
                key={i}
                block={block}
                responses={sub.responses}
              />
            ))}
          </div>
        </section>

        <footer className="mt-4 text-[11px] text-slate-400 print:text-slate-600 text-center">
          Generated from {school.name ?? 'Growth Suite'} parent portal — Submission ID {sub.id}
        </footer>
      </div>
    </main>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</dt>
      <dd className={`text-slate-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function BlockView({
  block, responses,
}: {
  block: FormDef['field_schema'][number];
  responses: Record<string, unknown>;
}) {
  const type = block.type;
  if (type === 'header') {
    return <h3 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-1 mt-4">{block.text}</h3>;
  }
  if (type === 'paragraph') {
    return <p className="text-xs text-slate-500 italic print:text-slate-400">{block.text}</p>;
  }
  if (type === 'section') {
    return (
      <div className="mt-3 border-l-4 border-emerald-500 pl-2">
        <h3 className="text-sm font-bold text-slate-900">{block.text || block.label}</h3>
        {block.description ? <p className="text-[11px] text-slate-500">{block.description}</p> : null}
      </div>
    );
  }
  if (!block.key) return null;
  const key = block.key;
  const raw = responses[key];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-1 sm:gap-3">
      <dt className="text-xs font-semibold text-slate-700">{block.label}</dt>
      <dd className="text-sm text-slate-900">
        <ResponseValue type={type} value={raw} options={block.options} />
      </dd>
    </div>
  );
}

function ResponseValue({
  type, value, options,
}: {
  type: string | undefined;
  value: unknown;
  options?: Array<{ value: string; label: string }>;
}) {
  // Empty / missing
  if (value == null || value === '') {
    return <span className="text-slate-400 italic">— not answered —</span>;
  }
  // Drawn signature: data URL → real image. If the parent used the
  // "Type instead" fallback on a signature_drawn block, the value is
  // plain text — fall through to the typed branch below.
  if (type === 'signature_drawn' && typeof value === 'string' && value.startsWith('data:image/')) {
    return (
      <div className="space-y-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={value}
          alt="Parent signature"
          className="h-20 rounded border border-slate-300 bg-white"
        />
        <div className="text-[10px] text-slate-500 inline-flex items-center gap-1">
          <ImageIcon className="h-3 w-3" /> Drawn signature (PNG)
        </div>
      </div>
    );
  }
  // Typed signature: render in script font. Covers signature_typed
  // blocks AND signature_drawn blocks where the parent chose to type
  // their name instead of drawing.
  if ((type === 'signature_typed' || type === 'signature_drawn') && typeof value === 'string' && value.trim()) {
    return (
      <div className="space-y-1">
        <span
          className="text-xl text-slate-900"
          style={{ fontFamily: 'var(--font-signature), "Dancing Script", "Brush Script MT", cursive' }}
        >
          {value}
        </span>
        {type === 'signature_drawn' ? (
          <div className="text-[10px] text-slate-500">Typed signature (fallback to drawing)</div>
        ) : null}
      </div>
    );
  }
  // Multi-checkbox: array of values → labels
  if ((type === 'multi_checkbox' || Array.isArray(value)) && Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400 italic">— none selected —</span>;
    const labels = value.map((v) => {
      const opt = options?.find((o) => o.value === v);
      return opt?.label ?? String(v);
    });
    return (
      <ul className="list-disc ml-5 text-sm">
        {labels.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    );
  }
  // Single radio/select: look up label
  if ((type === 'radio' || type === 'select') && typeof value === 'string' && options) {
    const opt = options.find((o) => o.value === value);
    return <span>{opt?.label ?? value}</span>;
  }
  // Checkbox boolean
  if (type === 'checkbox' && (typeof value === 'boolean' || value === 'yes' || value === 'no')) {
    return <span>{value === true || value === 'yes' ? '✓ Yes' : '✗ No'}</span>;
  }
  // Plain object → key/value (used for grids, per-student responses, etc.)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v._type === 'file_upload') {
      return (
        <span>
          {String(v.filename ?? 'file')} <span className="text-[10px] text-slate-500">({String(v.mime_type ?? '')}, {String(v.size_bytes ?? '?')} bytes)</span>
        </span>
      );
    }
    const entries = Object.entries(v).filter(([k]) => !k.startsWith('_'));
    if (entries.length === 0) return <span className="text-slate-400 italic">— empty —</span>;
    return (
      <ul className="text-sm space-y-0.5">
        {entries.map(([k, val]) => (
          <li key={k}>
            <span className="text-slate-600">{k}:</span>{' '}
            <span className="text-slate-900">{String(val)}</span>
          </li>
        ))}
      </ul>
    );
  }
  // Long text
  if (typeof value === 'string' && value.length > 60) {
    return <p className="whitespace-pre-wrap">{value}</p>;
  }
  return <span>{String(value)}</span>;
}
