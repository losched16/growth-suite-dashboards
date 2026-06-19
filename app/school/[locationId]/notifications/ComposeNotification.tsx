'use client';

// Compose + send an in-portal notification. The audience is a list of
// condition rows: ONE row = the quick picker (Everyone / Program /
// Classroom / Grade / Tag / Specific family); MORE rows = power filters
// combined with AND / OR. A live "reaches N parents" count updates as the
// audience changes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Plus, Trash2, Send, Loader2, Users, CheckCircle2, AlertCircle } from 'lucide-react';

type Field = 'all' | 'program' | 'homeroom' | 'grade_level' | 'tag' | 'family';
interface Condition { field: Field; values: string[] }

interface Options {
  programs: string[];
  homerooms: string[];
  grades: string[];
  tags: string[];
  families: Array<{ id: string; label: string }>;
}

const FIELD_LABELS: Record<Field, string> = {
  all: 'Everyone (all enrolled families)',
  program: 'Program',
  homeroom: 'Classroom',
  grade_level: 'Grade',
  tag: 'Tag',
  family: 'Specific family',
};

export function ComposeNotification({ schoolId, options }: { schoolId: string; options: Options }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [pinned, setPinned] = useState(false);

  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<Condition[]>([{ field: 'all', values: [] }]);

  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const audience = useMemo(() => ({ match, conditions }), [match, conditions]);

  // Debounced live reach count.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setCounting(true);
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/notifications/count`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audience }),
        });
        const j = await r.json();
        setCount(typeof j.count === 'number' ? j.count : 0);
      } catch { setCount(null); }
      finally { setCounting(false); }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [audience, schoolId]);

  function setCondition(i: number, patch: Partial<Condition>) {
    setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function addCondition() {
    setConditions((cs) => [...cs, { field: 'program', values: [] }]);
  }
  function removeCondition(i: number) {
    setConditions((cs) => (cs.length === 1 ? cs : cs.filter((_, j) => j !== i)));
  }

  async function send() {
    setSending(true);
    setResult(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, body,
          link_url: linkUrl || undefined,
          link_label: linkLabel || undefined,
          pinned,
          audience,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
      setResult({ ok: true, msg: `Sent to ${j.recipient_count} parent${j.recipient_count === 1 ? '' : 's'}.` });
      setTitle(''); setBody(''); setLinkUrl(''); setLinkLabel(''); setPinned(false);
      setConditions([{ field: 'all', values: [] }]); setMatch('all');
      router.refresh();
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : 'Could not send' });
    } finally {
      setSending(false);
    }
  }

  const canSend = title.trim() !== '' && body.trim() !== '' && (count ?? 0) > 0 && !sending;

  return (
    <div className="rounded-xl border border-black/10 bg-white p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Bell className="h-5 w-5 text-emerald-700" />
        <h2 className="text-sm font-semibold text-zinc-900">New notification</h2>
      </div>

      {/* Message */}
      <div className="space-y-3">
        <Field label="Title (shown bold in the parent's portal)">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
            placeholder="e.g. Picture day is Friday" className={inputCls} />
        </Field>
        <Field label="Message">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000}
            placeholder="Write what families need to know…" className={inputCls} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Link (optional, https://)">
            <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://…" className={inputCls} />
          </Field>
          <Field label="Button label (optional)">
            <input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)}
              placeholder="e.g. Sign up" className={inputCls} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
          <span>
            <span className="text-zinc-800">Pin to the top of their Home page</span>
            <span className="block text-[11px] text-zinc-500">Use for important notices. Parents can dismiss it.</span>
          </span>
        </label>
      </div>

      {/* Audience */}
      <div className="space-y-2 border-t border-zinc-100 pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">Send to</h3>
          {conditions.length > 1 ? (
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-zinc-500">Match</span>
              <button type="button" onClick={() => setMatch('all')}
                className={`rounded px-2 py-0.5 ${match === 'all' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-600'}`}>ALL</button>
              <button type="button" onClick={() => setMatch('any')}
                className={`rounded px-2 py-0.5 ${match === 'any' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-600'}`}>ANY</button>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          {conditions.map((c, i) => (
            <ConditionRow
              key={i}
              c={c}
              options={options}
              showJoiner={i > 0}
              joiner={match === 'any' ? 'OR' : 'AND'}
              canRemove={conditions.length > 1}
              onChange={(patch) => setCondition(i, patch)}
              onRemove={() => removeCondition(i)}
            />
          ))}
        </div>

        <button type="button" onClick={addCondition}
          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50">
          <Plus className="h-3 w-3" /> Add another filter
        </button>

        <div className="flex items-center gap-2 rounded-md bg-zinc-50 border border-zinc-200 px-3 py-2 text-sm">
          <Users className="h-4 w-4 text-zinc-500" />
          {counting ? (
            <span className="text-zinc-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Counting…</span>
          ) : (
            <span className="text-zinc-800">
              Reaches <strong className="tabular-nums">{count ?? 0}</strong> parent{count === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {result ? (
        <div className={`rounded-md px-3 py-2 text-sm flex items-center gap-2 ${result.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-rose-50 border border-rose-200 text-rose-800'}`}>
          {result.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {result.msg}
        </div>
      ) : null}

      <button type="button" onClick={send} disabled={!canSend}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {sending ? 'Sending…' : `Send notification${count ? ` to ${count}` : ''}`}
      </button>
    </div>
  );
}

function ConditionRow({
  c, options, showJoiner, joiner, canRemove, onChange, onRemove,
}: {
  c: Condition;
  options: Options;
  showJoiner: boolean;
  joiner: string;
  canRemove: boolean;
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  const valuesForField = (f: Field): string[] => {
    switch (f) {
      case 'program': return options.programs;
      case 'homeroom': return options.homerooms;
      case 'grade_level': return options.grades;
      case 'tag': return options.tags;
      default: return [];
    }
  };

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-2.5">
      <div className="flex items-center gap-2">
        {showJoiner ? (
          <span className="text-[10px] font-bold text-zinc-400 w-7 shrink-0">{joiner}</span>
        ) : <span className="text-[10px] text-zinc-400 w-7 shrink-0">Who</span>}
        <select
          value={c.field}
          onChange={(e) => onChange({ field: e.target.value as Field, values: [] })}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
        >
          {(['all', 'program', 'homeroom', 'grade_level', 'tag', 'family'] as Field[]).map((f) => (
            <option key={f} value={f}>{FIELD_LABELS[f]}</option>
          ))}
        </select>
        {canRemove ? (
          <button type="button" onClick={onRemove} className="ml-auto rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-700">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {c.field !== 'all' ? (
        <div className="mt-2 pl-9">
          {c.field === 'family' ? (
            <FamilyPicker
              families={options.families}
              selected={c.values}
              onChange={(values) => onChange({ values })}
            />
          ) : (
            <ChecklistPicker
              all={valuesForField(c.field)}
              selected={c.values}
              onChange={(values) => onChange({ values })}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChecklistPicker({ all, selected, onChange }: {
  all: string[]; selected: string[]; onChange: (v: string[]) => void;
}) {
  if (all.length === 0) {
    return <p className="text-[11px] text-zinc-400 italic">No options found on student records for this school.</p>;
  }
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((v) => (
        <button key={v} type="button" onClick={() => toggle(v)}
          className={`rounded-full border px-2.5 py-1 text-xs ${selected.includes(v)
            ? 'border-emerald-600 bg-emerald-600 text-white'
            : 'border-zinc-300 bg-white text-zinc-700 hover:border-emerald-400'}`}>
          {v}
        </button>
      ))}
    </div>
  );
}

function FamilyPicker({ families, selected, onChange }: {
  families: Array<{ id: string; label: string }>; selected: string[]; onChange: (v: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? families.filter((f) => f.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30)
    : families.slice(0, 12);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const selectedLabels = families.filter((f) => selected.includes(f.id));
  return (
    <div className="space-y-1.5">
      {selectedLabels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selectedLabels.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] text-white">
              {f.label}
              <button type="button" onClick={() => toggle(f.id)} className="hover:text-emerald-200">×</button>
            </span>
          ))}
        </div>
      ) : null}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search families…"
        className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm" />
      <div className="max-h-40 overflow-y-auto rounded border border-zinc-200 bg-white divide-y divide-zinc-100">
        {filtered.map((f) => (
          <button key={f.id} type="button" onClick={() => toggle(f.id)}
            className={`block w-full text-left px-2 py-1.5 text-xs hover:bg-emerald-50 ${selected.includes(f.id) ? 'text-emerald-800 font-medium' : 'text-zinc-700'}`}>
            {selected.includes(f.id) ? '✓ ' : ''}{f.label}
          </button>
        ))}
        {filtered.length === 0 ? <div className="px-2 py-2 text-[11px] text-zinc-400">No matches.</div> : null}
      </div>
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
