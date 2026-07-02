'use client';

// Three-step wizard:
//   1. Paste CSV → "Parse" → show detected headers
//   2. Map each schema field → CSV column (pre-filled from saved mapping)
//      Map plan_name CSV values → our plan slugs
//   3. Preview parsed rows → "Import" → commit

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, CheckCircle2, AlertCircle, Loader2, ChevronRight } from 'lucide-react';

interface PlanRow { id: string; slug: string; display_name: string }

interface PreviewRow {
  rowNumber: number;
  status: 'matched' | 'ambiguous' | 'no_student' | 'no_data' | 'ready';
  student_name?: string;
  enrollment_id?: string;
  annual_tuition_cents?: number;
  plan_name?: string;
  matched_plan_id?: string | null;
  reason?: string;
}

interface PreviewSummary {
  totalRows: number;
  matched: number;
  ambiguous: number;
  noStudent: number;
  noData: number;
}

const STANDARD_FIELDS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: 'student_first',       label: 'Student first name', required: true },
  { key: 'student_last',        label: 'Student last name',  required: true },
  { key: 'payer_email',         label: 'Payer email (helps disambiguate siblings)' },
  { key: 'student_grade',       label: 'Student grade (also helps disambiguate)' },
  { key: 'annual_tuition',      label: 'Annual tuition amount', required: true },
  { key: 'plan_name',           label: 'Payment plan name' },
  { key: 'sibling_discount',    label: 'Sibling discount amount (optional)' },
  { key: 'scholarship_amount',  label: 'Scholarship / FA amount (optional)' },
  { key: 'family_account_ref',  label: 'Account / family reference (audit only)' },
  { key: 'payer_first',         label: 'Payer first name (info only)' },
  { key: 'payer_last',          label: 'Payer last name (info only)' },
];

export function FactsImportClient({
  schoolId,
  academicYear: initialYear,
  savedMapping,
  planAliases,
  availablePlans,
}: {
  schoolId: string;
  academicYear: string;
  savedMapping: Record<string, string>;
  planAliases: Record<string, string>;
  availablePlans: PlanRow[];
}) {
  const router = useRouter();
  const [step, setStep] = useState<'paste' | 'map' | 'preview' | 'done'>('paste');
  const [csv, setCsv] = useState<string>('');
  const [academicYear, setAcademicYear] = useState<string>(initialYear);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>(savedMapping ?? {});
  const [aliasInput, setAliasInput] = useState<Record<string, string>>(planAliases ?? {});
  const [distinctPlanValues, setDistinctPlanValues] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ summary: PreviewSummary; rows: PreviewRow[] } | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function parse() {
    setErr(null);
    if (!csv.trim()) {
      setErr('Paste the CSV before parsing.');
      return;
    }
    // Quick local parse to get headers — full parse happens server-side
    const firstLine = csv.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) {
      setErr('Could not detect a header row.');
      return;
    }
    // Simple split (server uses full parser; this is just for display)
    const detected = firstLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    setHeaders(detected);
    // Pre-fill any saved mapping that matches detected headers
    const auto: Record<string, string> = {};
    for (const f of STANDARD_FIELDS) {
      const saved = savedMapping?.[f.key];
      if (saved && detected.includes(saved)) auto[f.key] = saved;
    }
    setMapping((prev) => ({ ...auto, ...prev }));
    setStep('map');
  }

  async function preparePreview() {
    setErr(null);
    // Validate required fields are mapped
    const missing = STANDARD_FIELDS
      .filter((f) => f.required && !mapping[f.key])
      .map((f) => f.label);
    if (missing.length > 0) {
      setErr(`Map these required columns: ${missing.join(', ')}`);
      return;
    }

    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/facts-import/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csv, academic_year: academicYear,
            field_mapping: mapping,
            plan_name_aliases: aliasInput,
          }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || `HTTP ${r.status}`);
        }
        const body = await r.json() as {
          import_id: string;
          summary: PreviewSummary;
          rows: PreviewRow[];
          distinct_plan_values: string[];
        };
        setPreview({ summary: body.summary, rows: body.rows });
        setImportId(body.import_id);
        setDistinctPlanValues(body.distinct_plan_values ?? []);
        setStep('preview');
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not preview import.');
      }
    });
  }

  async function commitImport() {
    if (!importId) return;
    setErr(null);
    const confirmed = window.confirm(
      `This will create or update ${preview?.summary.matched ?? 0} tuition enrollments. Continue?`,
    );
    if (!confirmed) return;
    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/facts-import/${importId}/commit`, {
          method: 'POST',
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || `HTTP ${r.status}`);
        }
        setStep('done');
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not commit import.');
      }
    });
  }

  return (
    <div className="space-y-5">
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {err}
        </div>
      ) : null}

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        <Step n={1} label="Paste CSV" active={step === 'paste'} done={step !== 'paste'} />
        <ChevronRight className="h-3 w-3 text-gray-300" />
        <Step n={2} label="Map columns" active={step === 'map'} done={step === 'preview' || step === 'done'} />
        <ChevronRight className="h-3 w-3 text-gray-300" />
        <Step n={3} label="Preview & commit" active={step === 'preview' || step === 'done'} done={step === 'done'} />
      </div>

      {/* Step 1 — paste */}
      {step === 'paste' ? (
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-800">Academic year</span>
            <input
              type="text"
              value={academicYear}
              onChange={(e) => setAcademicYear(e.target.value)}
              placeholder="2026-27"
              className="mt-1 block w-40 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-800">Paste your tuition CSV</span>
            <button
              type="button"
              onClick={() => {
                const cols = ['Student First Name', 'Student Last Name', 'Payer Email', 'Student Grade', 'Annual Tuition', 'Payment Plan', 'Sibling Discount', 'Scholarship Amount', 'Account Reference'];
                const example = ['Jane', 'Doe', 'parent@example.com', 'Kindergarten', '12800', 'Monthly', '0', '0', 'ACCT-1001'];
                const body = [cols.join(','), example.join(','), ''].join(String.fromCharCode(10));
                const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'tuition-import-template.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="text-xs font-medium text-emerald-700 underline hover:text-emerald-900"
            >
              Download blank template
            </button>
          </div>
          <label className="block">
            <span className="block text-[11px] text-gray-500 mt-0.5">
              Include the header row. Each row is one student&rsquo;s tuition. Columns can be named
              anything &mdash; you&rsquo;ll map them in the next step. Works with a FACTS / Blackbaud /
              TADS export or your own spreadsheet.
            </span>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={12}
              placeholder="Account Number,Student First,Student Last,Annual Tuition,Plan,..."
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-mono focus:border-emerald-600 focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={parse}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            <FileText className="h-4 w-4" /> Detect columns
          </button>
        </section>
      ) : null}

      {/* Step 2 — map */}
      {step === 'map' ? (
        <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <div className="text-sm font-medium text-gray-800">Map CSV columns → our fields</div>
            <p className="text-[11px] text-gray-500 mt-0.5">
              We detected <strong>{headers.length}</strong> columns in your CSV. Tell us which is which.
            </p>
          </div>
          <div className="space-y-2">
            {STANDARD_FIELDS.map((f) => (
              <div key={f.key} className="grid grid-cols-2 gap-3 items-center">
                <div className="text-sm">
                  {f.label} {f.required ? <span className="text-rose-600">*</span> : null}
                </div>
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) => setMapping((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
                >
                  <option value="">— not in CSV —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-100 pt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={preparePreview}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
              Preview
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 3 — preview */}
      {step === 'preview' && preview ? (
        <section className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-5 gap-2">
            <SummaryCard label="Total rows" value={preview.summary.totalRows} color="text-gray-900" />
            <SummaryCard label="Matched" value={preview.summary.matched} color="text-emerald-700" />
            <SummaryCard label="Ambiguous" value={preview.summary.ambiguous} color="text-amber-700" />
            <SummaryCard label="No student" value={preview.summary.noStudent} color="text-rose-700" />
            <SummaryCard label="No data" value={preview.summary.noData} color="text-slate-600" />
          </div>

          {/* Plan alias mapper — show distinct plan values from CSV that
              we couldn't auto-match, let operator map them. */}
          {distinctPlanValues.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
              <div className="text-sm font-medium text-amber-900 mb-2">
                Map plan names from CSV → our plans
              </div>
              <p className="text-[11px] text-amber-800 mb-3">
                Found these distinct plan values in the CSV. Pick which of our plans each matches.
                Saved for future imports.
              </p>
              <div className="space-y-2">
                {distinctPlanValues.map((csvVal) => (
                  <div key={csvVal} className="grid grid-cols-2 gap-3 items-center">
                    <div className="text-sm font-mono">{csvVal}</div>
                    <select
                      value={aliasInput[csvVal] ?? ''}
                      onChange={(e) => setAliasInput((prev) => ({ ...prev, [csvVal]: e.target.value }))}
                      className="rounded border border-amber-300 bg-white px-2 py-1 text-sm"
                    >
                      <option value="">— unmapped —</option>
                      {availablePlans.map((p) => (
                        <option key={p.id} value={p.slug}>{p.display_name} ({p.slug})</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Preview table — first 50 rows */}
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-100 bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Row #</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Matched student</th>
                  <th className="px-3 py-2 font-medium text-right">Annual</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {preview.rows.slice(0, 50).map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-3 py-2 text-gray-500">{row.rowNumber}</td>
                    <td className="px-3 py-2">
                      <RowStatusPill status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-gray-900">{row.student_name ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.annual_tuition_cents != null
                        ? `$${(row.annual_tuition_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {row.plan_name ?? '—'}
                      {row.plan_name && !row.matched_plan_id ? (
                        <span className="ml-1 text-rose-600 text-[10px]">(unmapped)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{row.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 50 ? (
              <div className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
                Showing first 50 of {preview.rows.length} rows. All rows will be processed on commit.
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2 border-t border-gray-200 pt-3">
            <button
              type="button"
              onClick={() => setStep('map')}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← Back to mapping
            </button>
            <button
              type="button"
              onClick={commitImport}
              disabled={busy || preview.summary.matched === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Commit {preview.summary.matched} enrollments
            </button>
            <p className="text-[11px] text-gray-500">Ambiguous / no-student / no-data rows will be skipped.</p>
          </div>
        </section>
      ) : null}

      {/* Step 4 — done */}
      {step === 'done' ? (
        <section className="rounded-lg border-2 border-emerald-200 bg-emerald-50 p-5 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-700" />
          <h2 className="mt-2 text-lg font-semibold text-emerald-900">Import complete</h2>
          <p className="mt-1 text-sm text-emerald-800">
            Families can now log in to {`/tuition`} and pick their payment plan.
          </p>
          <button
            type="button"
            onClick={() => {
              setStep('paste'); setCsv(''); setHeaders([]); setPreview(null); setImportId(null);
            }}
            className="mt-3 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
          >
            Run another import
          </button>
        </section>
      ) : null}
    </div>
  );
}

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 ${active ? 'text-emerald-700 font-semibold' : done ? 'text-gray-500' : 'text-gray-400'}`}>
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
        active ? 'bg-emerald-100 text-emerald-700' : done ? 'bg-gray-100 text-gray-500' : 'bg-gray-100 text-gray-400'
      }`}>{done ? '✓' : n}</span>
      {label}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function RowStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    matched:    'bg-emerald-100 text-emerald-800',
    ambiguous:  'bg-amber-100 text-amber-800',
    no_student: 'bg-rose-100 text-rose-800',
    no_data:    'bg-slate-100 text-slate-700',
    ready:      'bg-blue-100 text-blue-800',
  };
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${map[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
