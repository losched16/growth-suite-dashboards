'use client';

// Client manager for the website's dated documents: the monthly classroom
// newsletters / lesson plans and the lunch menu.
//
// The job this screen has to make trivial is the one the school does twelve
// times a year: "it's September, put September's newsletters up". So the
// month is chosen once at the top and defaults to the month after whatever
// is already published; dropped files are matched to the classroom names the
// school used last month; and uploading replaces that classroom's card for
// that month rather than stacking a second one.

import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  FileText, Upload, Trash2, Eye, EyeOff, Loader2, ExternalLink, X, CalendarDays,
} from 'lucide-react';

export interface AdminDoc {
  id: string;
  section: string;
  label: string;
  period_month: string | null;   // 'YYYY-MM-DD', first of the month
  original_filename: string;
  size_bytes: number;
  is_published: boolean;
}

export const SECTIONS: { key: string; title: string; hint: string }[] = [
  {
    key: 'newsletter',
    title: 'Classroom Newsletters & Lesson Plans',
    hint: 'One per classroom, each month.',
  },
  {
    key: 'menu',
    title: 'Lunch Menus',
    hint: 'The month’s food menu.',
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' or 'YYYY-MM' -> 'August 2026'. Parsed by hand rather than
 *  through Date(), which reads a date-only string as UTC midnight and so
 *  prints the month before for anyone west of Greenwich. */
function monthLabel(iso: string | null): string {
  if (!iso) return 'No month set';
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

const toMonthInput = (iso: string | null) => (iso ? iso.slice(0, 7) : '');

function addMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Guess which card a dropped file belongs to.
 *
 *  Schools name these files the same way every month
 *  ("Maple-Tree-August-2026-NL-LP.pdf"), so the labels already in use are
 *  the best dictionary there is: if a known label's words appear in the
 *  filename, reuse that label exactly. Only when nothing matches do we fall
 *  back to tidying the filename, and the operator can edit either way. */
function guessLabel(filename: string, known: string[]): string {
  const hay = filename.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ');
  let best = '';
  for (const label of known) {
    // The distinctive part of "Maple Tree Classroom" is "maple tree";
    // "classroom" matches everything and would pick the wrong card.
    const words = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
      .filter((w) => w.length > 2 && !['classroom', 'class', 'room', 'the', 'and'].includes(w));
    if (words.length === 0) continue;
    if (words.every((w) => hay.includes(w)) && label.length > best.length) best = label;
  }
  if (best) return best;

  const cleaned = hay
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b(${MONTHS.join('|').toLowerCase()}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b`, 'g'), ' ')
    .replace(/\b(nl|lp|newsletter|lesson|plan|plans|final|v\d+|copy)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean).slice(0, 4);
  if (words.length === 0) return 'Untitled';
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

interface Pending { key: string; file: File; label: string }

export function DocumentsManager({ locationId, initialDocs }: {
  locationId: string;
  initialDocs: AdminDoc[];
}) {
  const [docs, setDocs] = useState<AdminDoc[]>(initialDocs);
  const [section, setSection] = useState<string>(SECTIONS[0].key);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const flash = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 4000); }, []);

  // Labels this school already uses in this section, newest month first:
  // the dictionary guessLabel matches dropped filenames against.
  const knownLabels = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of docs) {
      if (d.section !== section) continue;
      if (seen.has(d.label.toLowerCase())) continue;
      seen.add(d.label.toLowerCase());
      out.push(d.label);
    }
    return out;
  }, [docs, section]);

  // Default to the month after the newest one already up, because that is
  // almost always what the school came here to do.
  const newestMonth = useMemo(() => {
    const months = docs.filter((d) => d.section === section && d.period_month)
      .map((d) => toMonthInput(d.period_month))
      .sort();
    return months.length ? months[months.length - 1] : null;
  }, [docs, section]);

  const [month, setMonth] = useState<string>(() => {
    const months = initialDocs.filter((d) => d.period_month)
      .map((d) => toMonthInput(d.period_month)).sort();
    return months.length ? addMonth(months[months.length - 1]) : thisMonth();
  });

  // What last month contained, shown as a checklist so the school can see at
  // a glance whether they have dropped in everything.
  const lastMonthLabels = useMemo(
    () => (newestMonth
      ? docs.filter((d) => d.section === section && toMonthInput(d.period_month) === newestMonth)
        .map((d) => d.label)
      : []),
    [docs, section, newestMonth],
  );

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setErr(null);
    setPending((p) => [
      ...p,
      ...list.map((file, i) => ({
        key: `${Date.now()}-${i}-${file.name}`,
        file,
        label: guessLabel(file.name, knownLabels),
      })),
    ]);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  async function uploadAll() {
    if (pending.length === 0) return;
    const blank = pending.find((p) => !p.label.trim());
    if (blank) { setErr('Give every file a name before uploading.'); return; }
    setErr(null);
    setBusy({ done: 0, total: pending.length });

    const failures: string[] = [];
    let remaining = [...pending];
    for (const item of pending) {
      try {
        const fd = new FormData();
        fd.append('file', item.file);
        fd.append('label', item.label.trim());
        fd.append('section', section);
        if (month) fd.append('month', month);

        const r = await fetch('/api/school/website-documents', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Upload failed.');

        const added: AdminDoc = data.document;
        setDocs((all) => [
          // A replacement for the same slot comes back as a new id; drop the
          // old row so the list doesn't briefly show both.
          ...all.filter((d) => !(d.section === added.section
            && d.period_month === added.period_month
            && d.label.toLowerCase() === added.label.toLowerCase())),
          added,
        ]);
        remaining = remaining.filter((p) => p.key !== item.key);
        setPending(remaining);
      } catch (e) {
        failures.push(`${item.file.name}: ${e instanceof Error ? e.message : 'failed'}`);
      } finally {
        setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
    }

    setBusy(null);
    if (failures.length) setErr(failures.join(' · '));
    const ok = pending.length - failures.length;
    if (ok > 0) flash(`${ok} document${ok === 1 ? '' : 's'} published for ${monthLabel(month)}.`);
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch(`/api/school/website-documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { setErr(data.error || 'Could not save that.'); return; }
    setDocs((all) => all.map((d) => (d.id === id ? { ...d, ...data.document } : d)));
  }

  async function remove(doc: AdminDoc) {
    if (!confirm(`Remove "${doc.label}" (${monthLabel(doc.period_month)}) from the website?`)) return;
    const r = await fetch(`/api/school/website-documents/${doc.id}`, { method: 'DELETE' });
    if (!r.ok) { setErr('Could not remove that document.'); return; }
    setDocs((all) => all.filter((d) => d.id !== doc.id));
    flash('Removed.');
  }

  // Grouped for display: section, then month, newest first.
  const grouped = useMemo(() => {
    return SECTIONS.map((s) => {
      const mine = docs.filter((d) => d.section === s.key);
      const months = [...new Set(mine.map((d) => toMonthInput(d.period_month)))]
        .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a)));
      return {
        ...s,
        months: months.map((ym) => ({
          ym,
          docs: mine.filter((d) => toMonthInput(d.period_month) === ym)
            .sort((a, b) => a.label.localeCompare(b.label)),
        })),
      };
    }).filter((s) => s.months.length > 0);
  }, [docs]);

  const sectionTitle = SECTIONS.find((s) => s.key === section)?.title ?? section;

  return (
    <div className="space-y-6">
      {msg ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
      ) : null}
      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
      ) : null}

      {/* ── This month's upload ───────────────────────────────────────── */}
      <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-emerald-900 flex items-center gap-1.5">
          <Upload className="h-4 w-4" /> Add documents for a month
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-gray-700">What are these?</span>
            <select
              value={section}
              onChange={(e) => { setSection(e.target.value); setPending([]); }}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {SECTIONS.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
            <span className="mt-0.5 block text-[11px] text-gray-500">
              {SECTIONS.find((s) => s.key === section)?.hint}
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-700">Which month are they for?</span>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            />
            <span className="mt-0.5 block text-[11px] text-gray-500">
              The website shows the newest month on its own, so this is what
              moves the page forward.
            </span>
          </label>
        </div>

        {lastMonthLabels.length > 0 ? (
          <p className="text-[11px] text-gray-600">
            <CalendarDays className="mr-1 inline h-3 w-3 text-gray-400" />
            {monthLabel(newestMonth)} had{' '}
            <span className="font-medium">{lastMonthLabels.join(', ')}</span>.
            Drop the same set in for {monthLabel(month)} and we will match the names up.
          </p>
        ) : null}

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition ${
            dragging ? 'border-emerald-500 bg-emerald-50' : 'border-emerald-300 bg-white'
          }`}
        >
          <FileText className="mx-auto mb-2 h-8 w-8 text-emerald-300" />
          <p className="text-sm text-gray-700">
            Drag the month&apos;s files here, or{' '}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="font-semibold text-emerald-700 underline underline-offset-2"
            >
              choose files
            </button>
            .
          </p>
          <p className="mt-1 text-[11px] text-gray-500">PDF, image, or Word. Up to 25 MB each.</p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>

        {pending.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-gray-700">
              Ready to publish to {sectionTitle} &middot; {monthLabel(month)}
            </div>
            <ul className="space-y-2">
              {pending.map((p) => (
                <li key={p.key} className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <input
                      value={p.label}
                      onChange={(e) => setPending((all) => all.map((x) =>
                        (x.key === p.key ? { ...x, label: e.target.value } : x)))}
                      list="website-doc-labels"
                      placeholder="Name shown on the website"
                      className="block w-full rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <div className="mt-0.5 truncate text-[11px] text-gray-500">
                      {p.file.name} &middot; {fmtBytes(p.file.size)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPending((all) => all.filter((x) => x.key !== p.key))}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    aria-label={`Remove ${p.file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <datalist id="website-doc-labels">
              {knownLabels.map((l) => <option key={l} value={l} />)}
            </datalist>
            <div className="flex items-center justify-end gap-3">
              {busy ? (
                <span className="text-xs text-gray-600">{busy.done} of {busy.total} uploaded&hellip;</span>
              ) : null}
              <button
                type="button"
                onClick={uploadAll}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Publish {pending.length} document{pending.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── What is on the website now ────────────────────────────────── */}
      {grouped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900">Nothing on the website yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Upload this month&apos;s newsletters above. They appear on the Parent
            Resources page within a couple of minutes, with no developer and no
            deploy.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((s) => (
            <section key={s.key} className="space-y-3">
              <div className="border-b border-gray-200 pb-1">
                <h2 className="text-sm font-semibold text-gray-900">{s.title}</h2>
              </div>

              {s.months.map(({ ym, docs: list }, i) => (
                <div key={ym || 'none'} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {monthLabel(ym || null)}
                    </h3>
                    {i === 0 ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                        Showing on the site
                      </span>
                    ) : null}
                  </div>
                  <ul className="space-y-2">
                    {list.map((d) => (
                      <li key={d.id} className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            defaultValue={d.label}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== d.label) patch(d.id, { label: v });
                            }}
                            className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                            aria-label="Name shown on the website"
                          />
                          <input
                            type="month"
                            defaultValue={toMonthInput(d.period_month)}
                            onChange={(e) => patch(d.id, { month: e.target.value || null })}
                            className="rounded border border-gray-300 px-2 py-1 text-sm"
                            aria-label="Month this document is for"
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-2">
                          <div className="truncate text-[11px] text-gray-500">
                            {d.original_filename} &middot; {fmtBytes(d.size_bytes)}
                            {d.is_published ? '' : ' · hidden from the website'}
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href={`/api/school/website-documents/${d.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                            >
                              <ExternalLink className="h-3 w-3" /> Preview
                            </a>
                            <button
                              type="button"
                              onClick={() => patch(d.id, { is_published: !d.is_published })}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
                            >
                              {d.is_published
                                ? <><EyeOff className="h-3 w-3" /> Hide</>
                                : <><Eye className="h-3 w-3" /> Show</>}
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(d)}
                              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3 w-3" /> Remove
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      <p className="text-[11px] text-gray-500">
        The website reads this list from{' '}
        <code className="rounded bg-gray-100 px-1">/api/website/documents/{locationId}</code>{' '}
        and caches it for two minutes, so give a new upload a moment to appear.
      </p>
    </div>
  );
}
