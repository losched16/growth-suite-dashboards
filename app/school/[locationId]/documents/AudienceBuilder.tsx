'use client';

// Reusable audience condition builder — the same UX as the notifications
// composer (quick picker for one row, AND/OR power filters for more).
// Kept prop-driven so a form can host TWO of these (include + exclude).

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

export type Field = 'all' | 'program' | 'homeroom' | 'grade_level' | 'tag' | 'family';
export interface Condition { field: Field; values: string[] }

export interface AudienceOptions {
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

export function AudienceBuilder({
  options, match, conditions, onMatch, onConditions, allowAll = true,
}: {
  options: AudienceOptions;
  match: 'all' | 'any';
  conditions: Condition[];
  onMatch: (m: 'all' | 'any') => void;
  onConditions: (c: Condition[]) => void;
  // false for the EXCLUDE builder — "exclude everyone" is never sensible.
  allowAll?: boolean;
}) {
  const setCondition = (i: number, patch: Partial<Condition>) =>
    onConditions(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const addCondition = () => onConditions([...conditions, { field: 'program', values: [] }]);
  const removeCondition = (i: number) =>
    onConditions(conditions.length === 1 ? conditions : conditions.filter((_, j) => j !== i));

  return (
    <div className="space-y-2">
      {conditions.length > 1 ? (
        <div className="flex items-center justify-end gap-1 text-[11px]">
          <span className="text-zinc-500">Match</span>
          <button type="button" onClick={() => onMatch('all')}
            className={`rounded px-2 py-0.5 ${match === 'all' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-600'}`}>ALL</button>
          <button type="button" onClick={() => onMatch('any')}
            className={`rounded px-2 py-0.5 ${match === 'any' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-600'}`}>ANY</button>
        </div>
      ) : null}
      {conditions.map((c, i) => (
        <ConditionRow key={i} c={c} options={options} allowAll={allowAll}
          showJoiner={i > 0} joiner={match === 'any' ? 'OR' : 'AND'}
          canRemove={conditions.length > 1}
          onChange={(patch) => setCondition(i, patch)} onRemove={() => removeCondition(i)} />
      ))}
      <button type="button" onClick={addCondition}
        className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50">
        <Plus className="h-3 w-3" /> Add another filter
      </button>
    </div>
  );
}

function ConditionRow({
  c, options, showJoiner, joiner, canRemove, allowAll, onChange, onRemove,
}: {
  c: Condition; options: AudienceOptions; showJoiner: boolean; joiner: string;
  canRemove: boolean; allowAll: boolean;
  onChange: (patch: Partial<Condition>) => void; onRemove: () => void;
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
  const fields = (allowAll
    ? ['all', 'program', 'homeroom', 'grade_level', 'tag', 'family']
    : ['program', 'homeroom', 'grade_level', 'tag', 'family']) as Field[];

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-2.5">
      <div className="flex items-center gap-2">
        {showJoiner
          ? <span className="text-[10px] font-bold text-zinc-400 w-7 shrink-0">{joiner}</span>
          : <span className="text-[10px] text-zinc-400 w-7 shrink-0">Who</span>}
        <select value={c.field}
          onChange={(e) => onChange({ field: e.target.value as Field, values: [] })}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm">
          {fields.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
        </select>
        {canRemove ? (
          <button type="button" onClick={onRemove} className="ml-auto rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-700">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {c.field !== 'all' ? (
        <div className="mt-2 pl-9">
          {c.field === 'family'
            ? <FamilyPicker families={options.families} selected={c.values} onChange={(values) => onChange({ values })} />
            : <ChecklistPicker all={valuesForField(c.field)} selected={c.values} onChange={(values) => onChange({ values })} />}
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
