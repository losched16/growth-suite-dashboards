'use client';

// Inline upload form for the Documents Browser. Renders a file input +
// metadata fields. Posts to /api/school/documents/upload as multipart.
// On success, full-page reloads so the documents list re-fetches.

import { useState } from 'react';
import { Upload, FileUp } from 'lucide-react';
import type { StudentOption } from './fetcher';

export function UploadForm({
  students,
  categories,
}: {
  students: StudentOption[];
  categories: string[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(e.currentTarget);
      const r = await fetch('/api/school/documents/upload', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setErr(data.error || `Upload failed (${r.status})`);
        return;
      }
      // Reload to refresh the list. Could be smarter (optimistic insert)
      // later, but reload is simple and correct.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
      >
        <Upload className="h-4 w-4" /> Upload document
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border-2 border-blue-300 bg-blue-50/30 p-4 space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-blue-900 flex items-center gap-1.5">
          <FileUp className="h-4 w-4" /> Upload a document
        </h3>
        <button type="button" onClick={() => setOpen(false)}
          className="text-xs text-blue-700 hover:text-blue-900 underline">cancel</button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">Student *</span>
          <select name="student_id" required className={inputCls}>
            <option value="">— select a student —</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display}{s.classroom_name ? ` · ${s.classroom_name}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">Category *</span>
          <select name="category" required className={inputCls}>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>

        <label className="block text-sm sm:col-span-2">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">Title *</span>
          <input type="text" name="title" required placeholder="e.g. Immunization record 2026" className={inputCls} />
        </label>

        <label className="block text-sm sm:col-span-2">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">Description (optional)</span>
          <input type="text" name="description" placeholder="Any context the teacher / nurse should know" className={inputCls} />
        </label>

        <label className="block text-sm">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">Expires (optional)</span>
          <input type="date" name="expires_at" className={inputCls} />
        </label>

        <label className="block text-sm">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-slate-700">File * (max 10MB)</span>
          <input
            type="file" name="file" required
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.doc,.docx,.txt"
            className="mt-0.5 w-full text-sm"
          />
        </label>
      </div>

      <div className="border-t border-blue-200 pt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="visible_to_teacher" value="1" defaultChecked
            className="h-4 w-4 rounded border-slate-300" />
          <span>Visible to teachers in the classroom-scoped dashboard</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="visible_to_parent" value="1"
            className="h-4 w-4 rounded border-slate-300" />
          <span>Visible to the family in the parent portal</span>
        </label>
      </div>

      {err ? <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">{err}</div> : null}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300">
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </form>
  );
}

const inputCls = 'mt-0.5 block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none';
