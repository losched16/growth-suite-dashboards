'use client';

// Per-slot editor card. Shows what staff see right now (the current
// upload, or the bundled default) and lets an editor post a new one:
// pick a PDF or a photo -> preview it -> Publish. A PDF is converted to
// an image in the browser first, so what is previewed is exactly what
// gets published. After publishing, the card cache-busts so the new
// image shows instantly.

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Loader2, RotateCcw, UploadCloud, Image as ImageIcon } from 'lucide-react';
import { menuPdfToImage, MENU_PDF_MAX_PAGES } from '@/lib/menus-pdf';

const MAX_BYTES = 15 * 1024 * 1024;

function defaultMonthLabel(): string {
  return new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function MenuSlotEditor({
  slot, label, sub, hasUpload, lastUploadedAt, lastUploadedBy, lastLabel, fallbackPath,
}: {
  slot: string;
  label: string;
  sub: string;
  hasUpload: boolean;
  lastUploadedAt: string | null;
  lastUploadedBy: string | null;
  lastLabel: string | null;
  fallbackPath: string;
}) {
  const [busy, setBusy] = useState<'prepare' | 'publish' | 'revert' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [cacheBust, setCacheBust] = useState(0);
  const [hasUploadState, setHasUploadState] = useState(hasUpload);
  const [lastWhen, setLastWhen] = useState(lastUploadedAt);
  const [lastWho, setLastWho] = useState(lastUploadedBy);
  const [lastMonth, setLastMonth] = useState(lastLabel);

  // The file waiting to be published (already an image) + its preview.
  const [pending, setPending] = useState<{ blob: Blob; filename: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [monthLabel, setMonthLabel] = useState(defaultMonthLabel());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const srcCurrent = hasUploadState
    ? `/api/school/menus/${slot}/file${cacheBust ? `?v=${cacheBust}` : ''}`
    : fallbackPath;

  function clearPending() {
    setPending(null);
    setPreviewUrl(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setErr(null);
    setNote(null);
    setDone(false);
    if (!file) return;
    setBusy('prepare');
    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      let blob: Blob = file;
      let filename = file.name;
      if (isPdf) {
        const c = await menuPdfToImage(file);
        blob = c.blob;
        filename = c.filename;
        if (c.pagesInPdf > c.pagesUsed) {
          setNote(`This PDF has ${c.pagesInPdf} pages; the first ${MENU_PDF_MAX_PAGES} are shown.`);
        }
      } else if (!file.type.startsWith('image/')) {
        throw new Error('Choose a PDF or a picture (PNG, JPG or WebP).');
      }
      if (blob.size > MAX_BYTES) {
        throw new Error(`That file is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 15 MB. Try a smaller photo or a lower-quality PDF.`);
      }
      setPending({ blob, filename });
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e2) {
      clearPending();
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!pending) return;
    setErr(null);
    setBusy('publish');
    try {
      const fd = new FormData();
      fd.set('file', new File([pending.blob], pending.filename, { type: pending.blob.type || 'image/png' }));
      fd.set('display_label', monthLabel.trim());
      const r = await fetch(`/api/school/menus/${slot}`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
      } else {
        setHasUploadState(true);
        setCacheBust(Date.now());
        setLastWhen(new Date().toISOString());
        setLastWho('you');
        setLastMonth(monthLabel.trim() || null);
        clearPending();
        setNote(null);
        setDone(true);
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    if (!confirm(`Remove the current ${label} and go back to the original image?`)) return;
    setBusy('revert');
    setDone(false);
    try {
      const r = await fetch(`/api/school/menus/${slot}`, { method: 'DELETE' });
      if (r.ok) {
        setHasUploadState(false);
        setCacheBust(Date.now());
        setLastWhen(null);
        setLastWho(null);
        setLastMonth(null);
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
            {lastMonth ? `${lastMonth} · ` : ''}Posted {lastWhen ? new Date(lastWhen).toLocaleDateString() : ''} {lastWho ? `· by ${lastWho}` : ''}
          </span>
        ) : (
          <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
            Original image (nothing posted yet)
          </span>
        )}
      </header>

      <div className="p-4 grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
            {pending ? 'New (not posted yet)' : 'What staff see now'}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/40 p-2 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={previewUrl ?? cacheBust}   // remount so iOS Safari re-fetches reliably
              src={previewUrl ?? srcCurrent}
              alt={label}
              className="max-h-80 w-auto object-contain"
            />
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              1. Choose this month&rsquo;s file (PDF or photo)
            </span>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf,image/*"
              onChange={onPick}
              disabled={busy !== null}
              className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
            />
          </label>
          {busy === 'prepare' ? (
            <div className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing preview…
            </div>
          ) : null}

          {pending ? (
            <>
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  2. Label shown to staff
                </span>
                <input
                  type="text"
                  value={monthLabel}
                  onChange={(e) => setMonthLabel(e.target.value)}
                  maxLength={60}
                  placeholder="October 2026"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
                />
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={publish}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                  3. Post it for all staff
                </button>
                <button
                  type="button"
                  onClick={clearPending}
                  disabled={busy !== null}
                  className="text-[11px] text-slate-500 hover:text-slate-800 underline"
                >
                  Cancel
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                This replaces the {hasUploadState ? 'current' : 'original'} {label.toLowerCase()} for everyone.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-slate-500 inline-flex items-start gap-1">
              <FileUp className="h-3.5 w-3.5 mt-px shrink-0" />
              You&rsquo;ll see a preview before anything changes for staff.
            </p>
          )}

          {note ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{note}</div>
          ) : null}
          {done ? (
            <div className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" /> Posted. Staff see it within a minute.
            </div>
          ) : null}
          {hasUploadState && !pending ? (
            <button
              type="button"
              onClick={revert}
              disabled={busy !== null}
              className="block mt-1 inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 underline"
            >
              {busy === 'revert' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Go back to the original image
            </button>
          ) : null}
          {err ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">{err}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
