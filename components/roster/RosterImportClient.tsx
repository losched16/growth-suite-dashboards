'use client';

// Roster CSV import flow, shared by the operator page
// (/admin/[schoolId]/roster-import) and the school-facing page
// (/school/[locationId]/roster-import). Three states:
//   1. Editing  — upload a .csv or paste, Preview button
//   2. Previewing — show counts + sample names + errors, Apply / Edit again
//   3. Applied  — show success summary, link onward
//
// Preview and apply both POST to the same API endpoint with different
// op values. No client-side parsing — server is the source of truth.

import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileText, Loader2, Send, Upload } from 'lucide-react';

interface PreviewSample {
  new_families: string[];
  new_students: string[];
}
interface PreviewData {
  total_rows: number;
  families_to_create: number;
  families_to_reuse: number;
  parents_to_create: number;
  parents_to_reuse: number;
  students_to_create: number;
  students_to_reuse: number;
  samples: PreviewSample;
}
interface ParseError {
  row_number: number;
  raw_row: string;
  message: string;
}

const TEMPLATE_CSV = [
  'family_name,primary_parent_first,primary_parent_last,primary_parent_email,primary_parent_phone,second_parent_first,second_parent_last,second_parent_email,second_parent_phone,student_first,student_last,student_dob,classroom,program',
  'Smith Family,Jane,Smith,jane@example.com,555-555-1234,John,Smith,john@example.com,555-555-5678,Emma,Smith,2020-04-15,Sunflower,Primary',
  'Smith Family,Jane,Smith,jane@example.com,555-555-1234,John,Smith,john@example.com,555-555-5678,Liam,Smith,2018-09-02,Maple,Lower Elementary',
].join('\n');

interface Props {
  schoolId: string;
  // Defaults preserve the original operator-page behavior.
  endpoint?: string;
  doneHref?: string;
  doneLabel?: string;
  // School-facing endpoint reads school_id from the form body.
  sendSchoolId?: boolean;
}

export function RosterImportClient({
  schoolId,
  endpoint,
  doneHref,
  doneLabel,
  sendSchoolId,
}: Props) {
  const apiUrl = endpoint ?? `/api/admin/schools/${schoolId}/roster-import`;
  const finishedHref = doneHref ?? `/admin/${schoolId}`;
  const finishedLabel = doneLabel ?? 'Back to school';

  const [csv, setCsv] = useState<string>('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [stage, setStage] = useState<'editing' | 'previewing' | 'applying' | 'applied'>('editing');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [appliedResult, setAppliedResult] = useState<{ students_to_create: number; duration_ms: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function buildForm(op: 'preview' | 'apply'): FormData {
    const fd = new FormData();
    fd.set('csv', csv);
    fd.set('op', op);
    if (sendSchoolId) fd.set('school_id', schoolId);
    return fd;
  }

  async function onFilePicked(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setStage('editing');
    setTopLevelError(null);
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'roster-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function doPreview() {
    setBusy(true);
    setTopLevelError(null);
    try {
      const r = await fetch(apiUrl, { method: 'POST', body: buildForm('preview') });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        setTopLevelError(body.error ?? `HTTP ${r.status}`);
        setErrors(body.errors ?? []);
        return;
      }
      setPreview(body.preview);
      setErrors(body.errors ?? []);
      setStage('previewing');
    } finally {
      setBusy(false);
    }
  }

  async function doApply() {
    if (!confirm(`Apply the import? ${preview?.students_to_create ?? 0} new students will be created. Cannot be undone except by manual DB cleanup.`)) {
      return;
    }
    setStage('applying');
    setBusy(true);
    setTopLevelError(null);
    try {
      const r = await fetch(apiUrl, { method: 'POST', body: buildForm('apply') });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        setTopLevelError(body.error ?? `HTTP ${r.status}`);
        setStage('previewing');
        return;
      }
      setAppliedResult({
        students_to_create: body.result.students_to_create,
        duration_ms: body.result.duration_ms,
      });
      setStage('applied');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'applied' && appliedResult) {
    return (
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-5 space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-700" />
          <h2 className="text-lg font-bold text-emerald-900">Import applied</h2>
        </div>
        <p className="text-sm text-emerald-900">
          Created <strong>{appliedResult.students_to_create}</strong> new student{appliedResult.students_to_create === 1 ? '' : 's'} (existing records reused). Took {appliedResult.duration_ms}ms.
        </p>
        <div className="flex items-center gap-3 pt-2">
          <a href={finishedHref} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800">
            {finishedLabel}
          </a>
          <button
            type="button"
            onClick={() => { setCsv(''); setFileName(null); setPreview(null); setAppliedResult(null); setStage('editing'); }}
            className="text-xs text-slate-600 hover:text-slate-900 underline"
          >
            Import another CSV
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {topLevelError ? (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{topLevelError}</span>
        </div>
      ) : null}

      {/* Stage 1: editing */}
      {(stage === 'editing' || stage === 'previewing') ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => onFilePicked(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Upload className="h-4 w-4" /> Upload CSV file
            </button>
            <button
              type="button"
              onClick={downloadTemplate}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> Download template
            </button>
            {fileName ? <span className="text-xs text-slate-500">Loaded: <span className="font-mono">{fileName}</span></span> : null}
          </div>

          <label className="block">
            <span className="text-sm font-semibold text-slate-900">Or paste CSV</span>
            <span className="block text-[11px] text-slate-500 mt-0.5">
              Include the header row. See the expected columns above.
            </span>
            <textarea
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setFileName(null); if (stage === 'previewing') setStage('editing'); }}
              rows={14}
              placeholder="family_name,primary_parent_first,primary_parent_last,primary_parent_email,student_first,student_last,student_dob,classroom,program&#10;Smith Family,Jane,Smith,jane@example.com,Emma,Smith,2020-04-15,Sunflower,Primary"
              className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={doPreview}
              disabled={busy || !csv.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy && stage === 'editing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {stage === 'previewing' ? 'Re-preview' : 'Preview import'}
            </button>
            <p className="text-[11px] text-slate-500">No writes. Just shows what would happen.</p>
          </div>
        </div>
      ) : null}

      {/* Stage 2: previewing */}
      {stage === 'previewing' && preview ? (
        <div className="rounded-xl border-2 border-blue-300 bg-blue-50/30 p-4 space-y-3">
          <h2 className="text-lg font-bold text-blue-900">Preview</h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <Stat label="Total rows" value={preview.total_rows} />
            <Stat label="New families" value={preview.families_to_create} accent="emerald" />
            <Stat label="New students" value={preview.students_to_create} accent="emerald" />
            <Stat label="Existing students reused" value={preview.students_to_reuse} accent="slate" />
          </div>

          {errors.length > 0 ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3">
              <div className="text-sm font-semibold text-amber-900 mb-1">
                ⚠ {errors.length} row{errors.length === 1 ? '' : 's'} with validation errors (will be skipped):
              </div>
              <ul className="text-xs text-amber-900 ml-4 list-disc space-y-1 max-h-40 overflow-y-auto">
                {errors.slice(0, 20).map((e) => (
                  <li key={e.row_number}>
                    <strong>row {e.row_number}:</strong> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.samples.new_students.length > 0 ? (
            <div className="rounded border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold text-slate-700 mb-1">
                Sample new students ({preview.samples.new_students.length} shown):
              </div>
              <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5">
                {preview.samples.new_students.map((s, i) => <span key={i}>• {s}</span>)}
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2 pt-2 border-t border-blue-100">
            <button
              type="button"
              onClick={doApply}
              disabled={busy || errors.length > 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Apply import
            </button>
            <button
              type="button"
              onClick={() => setStage('editing')}
              className="text-xs text-slate-600 hover:text-slate-900 underline"
            >
              Edit CSV
            </button>
            {errors.length > 0 ? (
              <p className="text-[11px] text-rose-700 ml-2">Fix the {errors.length} validation error{errors.length === 1 ? '' : 's'} before applying.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'emerald' | 'slate' }) {
  const cls = accent === 'emerald' ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200';
  return (
    <div className={`rounded border ${cls} px-3 py-2`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">{label}</div>
      <div className="text-xl font-bold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}
