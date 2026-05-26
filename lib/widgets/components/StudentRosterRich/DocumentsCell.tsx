'use client';

// Inline Documents cell for the Student Roster row. Renders a count
// chip; clicking it lazy-loads the doc list for THIS student into a
// small popover. Each row also has an Upload affordance so the
// operator can attach a new doc without leaving the roster.
//
// Lazy-loading per-row keeps the initial render snappy even for big
// rosters — we don't bulk-fetch hundreds of doc lists upfront.

import { useState, useEffect, useRef } from 'react';
import { Download, FileText, Upload, X } from 'lucide-react';

interface Doc {
  id: string;
  title: string;
  category: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
  expires_at: string | null;
  visible_to_teacher: boolean;
  visible_to_parent: boolean;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DocumentsCell({
  studentId,
  studentDisplay,
  initialCount,
}: {
  studentId: string;
  studentDisplay: string;
  initialCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [count, setCount] = useState(initialCount);
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Lazy fetch when opened
  useEffect(() => {
    if (!open || docs !== null) return;
    let cancelled = false;
    // Intentional sync setState — we want to show the busy spinner the
    // instant the popover opens, before the async fetch runs. The
    // single extra render here is negligible vs the UX win.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErr(null);
    (async () => {
      try {
        const r = await fetch(`/api/school/documents/list?student_id=${encodeURIComponent(studentId)}`);
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok || !data.ok) {
          setErr(data.error || `HTTP ${r.status}`);
          return;
        }
        setDocs(data.documents ?? []);
        setCount((data.documents ?? []).length);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, docs, studentId]);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium ${
          count > 0
            ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100'
            : 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50'
        }`}
        title={count > 0 ? `View ${count} document(s)` : 'No documents — click to upload one'}
      >
        <FileText className="h-3 w-3" />
        {count}
      </button>

      {open ? (
        <div
          ref={popRef}
          className="absolute right-0 z-50 mt-1 w-[28rem] max-w-[80vw] rounded-lg border border-slate-300 bg-white shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <div className="text-sm font-semibold text-slate-900">
              Documents · <span className="text-slate-600">{studentDisplay}</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {busy ? (
              <div className="px-3 py-4 text-center text-xs text-slate-500 italic">Loading…</div>
            ) : err ? (
              <div className="px-3 py-3 text-xs text-rose-700">Couldn&rsquo;t load: {err}</div>
            ) : !docs || docs.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-slate-500 italic">
                No documents on file for this student yet.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {docs.map((d) => (
                  <li key={d.id} className="px-3 py-2 hover:bg-slate-50">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate" title={d.title}>{d.title}</div>
                        <div className="text-[10px] text-slate-500 flex items-center gap-2 mt-0.5">
                          {d.category ? (
                            <span className="inline-block rounded bg-slate-100 px-1 py-0.5 uppercase tracking-wide">{d.category}</span>
                          ) : null}
                          <span>{fmtBytes(d.size_bytes)}</span>
                          <span>{fmtDate(d.uploaded_at)}</span>
                          {d.expires_at ? <span className="text-amber-700">exp. {d.expires_at}</span> : null}
                        </div>
                      </div>
                      <a
                        href={`/api/school/documents/${d.id}/download`}
                        target="_blank" rel="noopener"
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 shrink-0"
                        title={`Download ${d.file_name}`}
                      >
                        <Download className="h-3 w-3" /> Open
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 flex items-center justify-between">
            <span>
              {docs ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : `${count} document${count === 1 ? '' : 's'}`}
            </span>
            <a
              href={`/school/${currentLocationId()}/documents?student=${encodeURIComponent(studentId)}`}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline"
            >
              <Upload className="h-3 w-3" /> Upload / manage in Documents tab
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Derives the location id from the current URL: /school/{locationId}/...
// Used to deep-link to the Documents dashboard pre-filtered for this
// student. If we ever move the URL structure, update this in one place.
function currentLocationId(): string {
  if (typeof window === 'undefined') return '';
  const m = window.location.pathname.match(/^\/school\/([^/]+)/);
  return m ? m[1] : '';
}
