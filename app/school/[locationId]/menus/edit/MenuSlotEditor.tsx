'use client';

// Per-slot editor card. Shows the current image (DB upload if present,
// /public fallback otherwise) and a file input to replace it. After a
// successful upload, busts the image cache by appending ?v=<ts> so the
// new image renders instantly without a hard reload.

import { useState, type FormEvent } from 'react';
import { Loader2, RotateCcw, UploadCloud, Image as ImageIcon } from 'lucide-react';

export function MenuSlotEditor({
  slot, label, sub, hasUpload, lastUploadedAt, lastUploadedBy, fallbackPath,
}: {
  slot: string;
  label: string;
  sub: string;
  hasUpload: boolean;
  lastUploadedAt: string | null;
  lastUploadedBy: string | null;
  fallbackPath: string;
}) {
  const [busy, setBusy] = useState<'upload' | 'revert' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cacheBust, setCacheBust] = useState(0);
  const [hasUploadState, setHasUploadState] = useState(hasUpload);
  const [lastWhen, setLastWhen] = useState(lastUploadedAt);
  const [lastWho, setLastWho] = useState(lastUploadedBy);

  const srcCurrent = hasUploadState
    ? `/api/school/menus/${slot}/file${cacheBust ? `?v=${cacheBust}` : ''}`
    : fallbackPath;

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy('upload');
    try {
      const fd = new FormData(e.currentTarget);
      const r = await fetch(`/api/school/menus/${slot}`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
      } else {
        setHasUploadState(true);
        setCacheBust(Date.now());
        setLastWhen(new Date().toISOString());
        setLastWho('you'); // server has the real email; this is just a quick UX cue
        (e.target as HTMLFormElement).reset();
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    if (!confirm(`Revert ${label} back to the default image? The current upload will be deleted.`)) return;
    setBusy('revert');
    try {
      const r = await fetch(`/api/school/menus/${slot}`, { method: 'DELETE' });
      if (r.ok) {
        setHasUploadState(false);
        setCacheBust(Date.now());
        setLastWhen(null);
        setLastWho(null);
      } else {
        const j = await r.json().catch(() => ({}));
        setErr(j.detail || j.error || `HTTP ${r.status}`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <header className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
            <ImageIcon className="h-4 w-4 text-blue-600" /> {label}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">{sub}</p>
        </div>
        {hasUploadState ? (
          <span className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold">
            Custom upload {lastWhen ? `· ${new Date(lastWhen).toLocaleDateString()}` : ''} {lastWho ? `· by ${lastWho}` : ''}
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
            Default image (no upload yet)
          </span>
        )}
      </header>

      <div className="p-4 grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4">
        <div>
          <div className="rounded-md border border-slate-200 bg-slate-50/40 p-2 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={cacheBust}     // remount on cache-bust so iOS Safari re-fetches reliably
              src={srcCurrent}
              alt={label}
              className="max-h-72 w-auto object-contain"
            />
          </div>
        </div>
        <form onSubmit={upload} className="space-y-3">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Replace with…</span>
            <input
              type="file"
              name="file"
              accept="image/*"
              required
              className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'upload' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
            Upload new {label}
          </button>
          {hasUploadState ? (
            <button
              type="button"
              onClick={revert}
              disabled={busy !== null}
              className="block mt-2 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 underline"
            >
              {busy === 'revert' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Revert to default
            </button>
          ) : null}
          {err ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">{err}</div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
