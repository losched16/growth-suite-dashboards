'use client';

// Per-row delete button for the forms list. Shows a confirmation
// dialog with the live submission count; types-DELETE required when
// the form has submissions. Calls the DELETE endpoint with the
// expected count so a TOCTOU between display + click gets caught.

import { useState } from 'react';
import { Trash2, Loader2, AlertTriangle } from 'lucide-react';

export function DeleteFormButton({
  schoolId, formId, displayName, slug, submissionCount,
}: {
  schoolId: string;
  formId: string;
  displayName: string;
  slug: string;
  submissionCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const requireType = submissionCount > 0;
  const canDelete = requireType ? typed.trim() === 'DELETE' : true;

  async function confirmDelete() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(
        `/api/admin/schools/${schoolId}/forms/${formId}?confirm_count=${submissionCount}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      // Hard reload the page so the list re-fetches without that row.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setErr(null); setTyped(''); }}
        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
        title="Delete this form"
      >
        <Trash2 className="h-3 w-3" /> Delete
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && setOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 text-rose-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">Delete &ldquo;{displayName}&rdquo;?</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">{slug}</p>
            {submissionCount > 0 ? (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                <p className="font-semibold mb-1">This form has {submissionCount} parent submission{submissionCount === 1 ? '' : 's'}.</p>
                <p>Deleting will also <strong>permanently destroy all {submissionCount} submission{submissionCount === 1 ? '' : 's'}</strong> — including any uploaded files, signatures, and audit history. This can&rsquo;t be undone.</p>
                <p className="mt-2">
                  Consider <em>unpublishing</em> instead (flip the Published toggle off) — parents won&rsquo;t see it, but the historical data stays intact.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-600">
                No submissions exist yet for this form, so the only thing being deleted is the
                form definition itself. Safe to remove.
              </p>
            )}

            {requireType ? (
              <label className="mt-3 block text-xs">
                <span className="font-medium text-slate-700">Type <code className="rounded bg-slate-100 px-1">DELETE</code> to confirm:</span>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-200"
                />
              </label>
            ) : null}

            {err ? (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{err}</div>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy || !canDelete}
                className="inline-flex items-center gap-1 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {busy ? 'Deleting…' : (submissionCount > 0 ? `Delete form + ${submissionCount} submission${submissionCount === 1 ? '' : 's'}` : 'Delete form')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
