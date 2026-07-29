'use client';

// Upload an "important document" to the parent portal, targeted with the
// notifications-style audience builder — plus an optional EXCLUDE
// audience ("everyone in Primary, except families tagged X").

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2, Users, CheckCircle2, AlertCircle, MinusCircle, Trash2, EyeOff, Eye } from 'lucide-react';
import { AudienceBuilder, type AudienceOptions, type Condition } from './AudienceBuilder';

export function ShareDocument({ schoolId, options }: { schoolId: string; options: AudienceOptions }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<Condition[]>([{ field: 'all', values: [] }]);
  const [useExclude, setUseExclude] = useState(false);
  const [exMatch, setExMatch] = useState<'all' | 'any'>('any');
  const [exConditions, setExConditions] = useState<Condition[]>([{ field: 'tag', values: [] }]);

  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const include = useMemo(() => ({ match, conditions }), [match, conditions]);

  // Live reach count for the INCLUDE audience (parents reached; the
  // exclude carve-out is applied per family at view time).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCounting(true);
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/notifications/count`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audience: include }),
        });
        const j = await r.json();
        setCount(typeof j.count === 'number' ? j.count : 0);
      } catch { setCount(null); }
      finally { setCounting(false); }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [include, schoolId]);

  async function save() {
    if (!file) return;
    setSaving(true); setResult(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('title', title);
      if (description.trim()) fd.set('description', description.trim());
      if (category) fd.set('category', category);
      fd.set('include', JSON.stringify(include));
      if (useExclude) fd.set('exclude', JSON.stringify({ match: exMatch, conditions: exConditions }));
      const r = await fetch(`/api/admin/schools/${schoolId}/shared-documents`, { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setResult({ ok: true, msg: `Shared "${title}" — visible to ${j.audience_label}.` });
      setFile(null); setTitle(''); setDescription(''); setCategory('');
      setConditions([{ field: 'all', values: [] }]); setMatch('all');
      setUseExclude(false); setExConditions([{ field: 'tag', values: [] }]); setExMatch('any');
      router.refresh();
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : 'Upload failed' });
    } finally {
      setSaving(false);
    }
  }

  const canSave = !!file && title.trim() !== '' && !saving;

  return (
    <div className="rounded-xl border border-black/10 bg-white p-5 space-y-5">
      <div className="flex items-center gap-2">
        <FileUp className="h-5 w-5 text-emerald-700" />
        <h2 className="text-sm font-semibold text-zinc-900">Share a document with families</h2>
      </div>

      <div className="space-y-3">
        <Field label="File (max 10 MB)">
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-700 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Title (what parents see)">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
              placeholder="e.g. 2026-27 Family Handbook" className={inputCls} />
          </Field>
          <Field label="Category (optional)">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              <option value="">—</option>
              <option value="handbook">Handbook</option>
              <option value="calendar">Calendar</option>
              <option value="forms">Forms & paperwork</option>
              <option value="menus">Menus</option>
              <option value="other">Other</option>
            </select>
          </Field>
        </div>
        <Field label="Description (optional, shown under the title)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000}
            placeholder="e.g. Please review before the first day of school" className={inputCls} />
        </Field>
      </div>

      <div className="space-y-2 border-t border-zinc-100 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">Who sees it</h3>
        <AudienceBuilder options={options} match={match} conditions={conditions}
          onMatch={setMatch} onConditions={setConditions} />
        <div className="flex items-center gap-2 rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-sm">
          <Users className="h-4 w-4 text-zinc-500" />
          {counting
            ? <span className="text-zinc-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Counting…</span>
            : <span className="text-zinc-800">Reaches <strong className="tabular-nums">{count ?? 0}</strong> parent{count === 1 ? '' : 's'}{useExclude ? ' (before exclusions)' : ''}</span>}
        </div>
      </div>

      <div className="space-y-2 border-t border-zinc-100 pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useExclude} onChange={(e) => setUseExclude(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300" />
          <span className="inline-flex items-center gap-1 text-zinc-800">
            <MinusCircle className="h-4 w-4 text-rose-500" /> Exclude some families
          </span>
        </label>
        {useExclude ? (
          <AudienceBuilder options={options} match={exMatch} conditions={exConditions}
            onMatch={setExMatch} onConditions={setExConditions} allowAll={false} />
        ) : null}
      </div>

      {result ? (
        <div className={`rounded-md px-3 py-2 text-sm flex items-center gap-2 ${result.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'}`}>
          {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {result.msg}
        </div>
      ) : null}

      <button type="button" onClick={save} disabled={!canSave}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
        {saving ? 'Uploading…' : 'Share document'}
      </button>
    </div>
  );
}

// Row actions for the existing-documents list: hide/show + delete.
export function DocActions({ schoolId, docId, isActive }: { schoolId: string; docId: string; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function patch(active: boolean) {
    setBusy(true);
    try {
      await fetch(`/api/admin/schools/${schoolId}/shared-documents/${docId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: active }),
      });
      router.refresh();
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm('Delete this document for every family? This cannot be undone.')) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/schools/${schoolId}/shared-documents/${docId}`, { method: 'DELETE' });
      router.refresh();
    } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-1">
      <button type="button" disabled={busy} onClick={() => patch(!isActive)}
        title={isActive ? 'Hide from parents (keeps the file)' : 'Show to parents again'}
        className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50">
        {isActive ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {isActive ? 'Hide' : 'Show'}
      </button>
      <button type="button" disabled={busy} onClick={remove}
        className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 hover:bg-rose-50 hover:text-rose-700">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const inputCls =
  'block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}
