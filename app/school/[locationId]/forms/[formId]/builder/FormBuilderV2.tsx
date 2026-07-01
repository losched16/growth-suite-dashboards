'use client';

// Form builder v2 — a drag-and-drop editor over the same field_schema the
// portal renderer already consumes. Phase 1: 3-pane layout (palette / canvas /
// inspector), native HTML5 drag-to-reorder, add/edit/delete fields, save.
// Phase 2 (next) adds the GHL field mapping + conditional-logic builder.
//
// It edits the SAME schema as the classic editor and saves through the same
// PATCH endpoint, so a form can move between the two freely.

import { useState } from 'react';
import {
  GripVertical, Plus, Trash2, Eye, ArrowLeft, Check, Loader2,
  Type, AlignLeft, Mail, Phone, Hash, Calendar, ChevronDown, CircleDot,
  CheckSquare, PenLine, Heading, Text as TextIcon, X, Search, Plug, Settings as SettingsIcon,
} from 'lucide-react';

interface Option { value: string; label: string; amount_cents?: number }
export interface FieldBlock {
  type: string;
  key?: string;
  label?: string;
  text?: string;
  help?: string;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  options?: Option[];
  visible_when?: { field: string; equals: string[] };
  prefill?: string;
  ghl_field_key?: string;
  [k: string]: unknown;
}

export interface GhlField { key: string; name: string; dataType: string; options: string[] }

export interface FormSettings {
  display_name: string;
  description: string | null;
  confirmation_message: string | null;
  notify_emails: string[];
  per_student: boolean;
  resubmission_allowed: boolean;
  is_active: boolean;
}

type PaletteType =
  | 'section' | 'paragraph'
  | 'text' | 'textarea' | 'email' | 'tel' | 'number' | 'date'
  | 'select' | 'radio' | 'checkbox' | 'signature_typed';

const PALETTE: Array<{ group: string; type: PaletteType; label: string; icon: React.ReactNode }> = [
  { group: 'Layout', type: 'section', label: 'Section', icon: <Heading className="h-4 w-4" /> },
  { group: 'Layout', type: 'paragraph', label: 'Text block', icon: <TextIcon className="h-4 w-4" /> },
  { group: 'Fields', type: 'text', label: 'Short text', icon: <Type className="h-4 w-4" /> },
  { group: 'Fields', type: 'textarea', label: 'Long text', icon: <AlignLeft className="h-4 w-4" /> },
  { group: 'Fields', type: 'email', label: 'Email', icon: <Mail className="h-4 w-4" /> },
  { group: 'Fields', type: 'tel', label: 'Phone', icon: <Phone className="h-4 w-4" /> },
  { group: 'Fields', type: 'number', label: 'Number', icon: <Hash className="h-4 w-4" /> },
  { group: 'Fields', type: 'date', label: 'Date', icon: <Calendar className="h-4 w-4" /> },
  { group: 'Choices', type: 'select', label: 'Dropdown', icon: <ChevronDown className="h-4 w-4" /> },
  { group: 'Choices', type: 'radio', label: 'Multiple choice', icon: <CircleDot className="h-4 w-4" /> },
  { group: 'Choices', type: 'checkbox', label: 'Checkbox', icon: <CheckSquare className="h-4 w-4" /> },
  { group: 'Sign', type: 'signature_typed', label: 'Signature', icon: <PenLine className="h-4 w-4" /> },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(PALETTE.map((p) => [p.type, p.label]));
const HAS_OPTIONS = new Set(['select', 'radio']);

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function makeField(type: PaletteType, existingKeys: Set<string>): FieldBlock {
  const base: FieldBlock = { type };
  if (type === 'section') { base.label = 'New section'; return base; }
  if (type === 'paragraph') { base.text = 'Add your text here.'; return base; }
  const label = TYPE_LABEL[type] ?? 'Field';
  let key = slugify(label) || 'field';
  let n = 1;
  while (existingKeys.has(key)) key = `${slugify(label)}_${++n}`;
  base.key = key;
  base.label = label;
  if (HAS_OPTIONS.has(type)) base.options = [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }];
  if (type === 'checkbox') base.label = 'I agree';
  return base;
}

// GHL custom-field dataType → the closest builder field type.
function inferType(dt: string): PaletteType {
  switch ((dt || '').toUpperCase()) {
    case 'LARGE_TEXT': case 'TEXTBOX_LIST': return 'textarea';
    case 'SINGLE_OPTIONS': case 'RADIO': case 'MULTIPLE_OPTIONS': case 'CHECKBOX': return 'select';
    case 'DATE': return 'date';
    case 'NUMERICAL': case 'MONETORY': return 'number';
    case 'PHONE': return 'tel';
    case 'EMAIL': return 'email';
    default: return 'text';
  }
}

// Connect a field to a Growth Suite (GHL) contact field: it prefills from the
// contact record (meta:<key>) and inherits the field's type + choices.
function connectFieldTo(f: FieldBlock, gf: GhlField): FieldBlock {
  const type = inferType(gf.dataType);
  const next: FieldBlock = { ...f, type, prefill: `meta:${gf.key}`, ghl_field_key: gf.key };
  if (!next.label || next.label === TYPE_LABEL[f.type]) next.label = gf.name;
  if (type === 'select' && gf.options.length) {
    next.options = gf.options.map((o) => ({ value: slugify(o) || o, label: o }));
  }
  return next;
}

export function FormBuilderV2({
  schoolId, formId, slug, initialSchema, initialSettings, ghlFields, previewHref, backHref,
}: {
  schoolId: string;
  formId: string;
  slug: string;
  displayName: string;
  initialSchema: FieldBlock[];
  initialSettings: FormSettings;
  ghlFields: GhlField[];
  previewHref: string;
  backHref: string;
}) {
  const [ghlSearch, setGhlSearch] = useState('');
  const [settings, setSettings] = useState<FormSettings>(initialSettings);
  const [fields, setFields] = useState<FieldBlock[]>(initialSchema);
  const [sel, setSel] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keys = new Set(fields.map((f) => f.key).filter(Boolean) as string[]);

  function mutate(next: FieldBlock[]) { setFields(next); setDirty(true); setSavedAt(null); }
  function patchSettings(patch: Partial<FormSettings>) { setSettings((s) => ({ ...s, ...patch })); setDirty(true); setSavedAt(null); }
  function addField(type: PaletteType) {
    const f = makeField(type, keys);
    mutate([...fields, f]);
    setSel(fields.length);
  }
  function addGhlField(gf: GhlField) {
    const f = connectFieldTo(makeField(inferType(gf.dataType), keys), gf);
    mutate([...fields, f]);
    setSel(fields.length);
  }
  function connectSelected(gf: GhlField | null) {
    if (sel == null) return;
    mutate(fields.map((f, j) => {
      if (j !== sel) return f;
      if (gf) return connectFieldTo(f, gf);
      const next = { ...f };
      delete next.prefill;
      delete next.ghl_field_key;
      return next;
    }));
  }
  function patchField(i: number, patch: Partial<FieldBlock>) {
    mutate(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }
  function deleteField(i: number) {
    mutate(fields.filter((_, j) => j !== i));
    setSel(null);
  }
  function moveField(from: number, to: number) {
    if (from === to) return;
    const a = [...fields];
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x);
    mutate(a);
    setSel(to);
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field_schema: fields,
          meta: {
            display_name: settings.display_name,
            description: settings.description,
            confirmation_message: settings.confirmation_message,
            notify_emails: settings.notify_emails,
            per_student: settings.per_student,
            resubmission_allowed: settings.resubmission_allowed,
            is_active: settings.is_active,
          },
        }),
      });
      if (!r.ok) {
        let msg = 'Could not save';
        try { const b = await r.json(); msg = b?.error || b?.detail || msg; } catch { /* ignore */ }
        throw new Error(String(msg).replace(/_/g, ' '));
      }
      setSavedAt(new Date()); setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const selField = sel != null ? fields[sel] : null;

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] min-h-[560px]">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <a href={backHref} className="text-slate-400 hover:text-slate-700" title="Back to forms"><ArrowLeft className="h-4 w-4" /></a>
          <span className="text-sm font-semibold text-slate-900 truncate">{settings.display_name}</span>
          <span className="font-mono text-[11px] text-slate-400 truncate">{slug}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setSel(null)}
            className={['inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium', sel === null ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'].join(' ')}>
            <SettingsIcon className="h-3.5 w-3.5" /> Settings
          </button>
          {err ? <span className="text-xs text-red-600">{err}</span>
            : savedAt ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" /> Saved</span>
            : dirty ? <span className="text-xs text-amber-600">Unsaved changes</span> : null}
          <a href={previewHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <Eye className="h-3.5 w-3.5" /> Preview
          </a>
          <button onClick={save} disabled={busy || !dirty}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
          </button>
        </div>
      </div>

      <div className="grid flex-1 min-h-0 grid-cols-[200px_1fr_300px]">
        {/* Palette */}
        <aside className="overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
          {['Layout', 'Fields', 'Choices', 'Sign'].map((group) => (
            <div key={group} className="mb-4">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">{group}</p>
              {PALETTE.filter((p) => p.group === group).map((p) => (
                <button key={p.type} onClick={() => addField(p.type)}
                  className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:border-emerald-300 hover:bg-emerald-50/50">
                  <span className="text-slate-500">{p.icon}</span>{p.label}
                </button>
              ))}
            </div>
          ))}
          {ghlFields.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Your Growth Suite fields</p>
              <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <input value={ghlSearch} onChange={(e) => setGhlSearch(e.target.value)} placeholder={`Search ${ghlFields.length} fields`}
                  className="w-full bg-transparent text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none" />
              </div>
              {ghlFields
                .filter((g) => !ghlSearch || g.name.toLowerCase().includes(ghlSearch.toLowerCase()) || g.key.includes(ghlSearch.toLowerCase()))
                .slice(0, 40)
                .map((g) => (
                  <button key={g.key} onClick={() => addGhlField(g)} title={g.key}
                    className="mb-1 flex w-full items-center gap-2 rounded-md border border-blue-200 bg-blue-50/60 px-2.5 py-1.5 text-left text-xs font-medium text-blue-800 hover:bg-blue-50">
                    <Plug className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{g.name}</span>
                  </button>
                ))}
            </div>
          ) : null}
        </aside>

        {/* Canvas */}
        <main className="overflow-y-auto bg-slate-100 p-6">
          <div className="mx-auto max-w-2xl space-y-2">
            {fields.length === 0 ? (
              <div className="rounded-lg border-2 border-dashed border-slate-300 py-16 text-center text-sm text-slate-400">
                Add a field from the left to get started.
              </div>
            ) : null}
            {fields.map((f, i) => {
              const isSel = sel === i;
              const isLayout = f.type === 'section' || f.type === 'paragraph';
              return (
                <div
                  key={('key' in f && f.key) ? String(f.key) : `pos-${i}`}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
                  onDrop={(e) => { e.preventDefault(); if (dragIdx != null) moveField(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
                  onClick={() => setSel(i)}
                  className={[
                    'group flex items-center gap-2 rounded-lg border bg-white px-3 py-2.5 cursor-pointer',
                    isSel ? 'border-emerald-500 ring-1 ring-emerald-500' : 'border-slate-200 hover:border-slate-300',
                    overIdx === i && dragIdx !== i ? 'border-t-2 border-t-emerald-500' : '',
                  ].join(' ')}
                >
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-300 group-hover:text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <p className={isLayout ? 'text-sm font-semibold text-slate-800' : 'text-sm font-medium text-slate-900 truncate'}>
                      {f.type === 'paragraph' ? (f.text || 'Text block') : (f.label || '(untitled)')}
                      {f.required ? <span className="ml-1 text-rose-500">*</span> : null}
                    </p>
                    {!isLayout ? (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {TYPE_LABEL[f.type] ?? f.type}
                        {f.prefill ? ' · linked to GHL' : ''}
                        {f.visible_when ? ' · conditional' : ''}
                        {f.readOnly ? ' · locked' : ''}
                      </p>
                    ) : null}
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteField(i); }}
                    className="shrink-0 text-slate-300 opacity-0 hover:text-rose-500 group-hover:opacity-100" title="Delete field">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </main>

        {/* Inspector */}
        <aside className="overflow-y-auto border-l border-slate-200 bg-white p-4">
          {selField ? (
            <Inspector
              key={sel}
              field={selField}
              allFields={fields}
              ghlFields={ghlFields}
              onPatch={(patch) => sel != null && patchField(sel, patch)}
              onConnect={connectSelected}
            />
          ) : (
            <FormSettingsPanel settings={settings} onPatch={patchSettings} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Inspector({ field, allFields, ghlFields, onPatch, onConnect }: { field: FieldBlock; allFields: FieldBlock[]; ghlFields: GhlField[]; onPatch: (patch: Partial<FieldBlock>) => void; onConnect: (gf: GhlField | null) => void }) {
  const isLayout = field.type === 'section' || field.type === 'paragraph';
  const hasOptions = HAS_OPTIONS.has(field.type);
  const input = 'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';
  const lbl = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400';

  return (
    <div className="space-y-4">
      <div className="text-xs font-semibold text-slate-800">{TYPE_LABEL[field.type] ?? field.type}</div>

      {field.type === 'paragraph' ? (
        <div>
          <label className={lbl}>Text</label>
          <textarea rows={4} className={input} value={field.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} />
        </div>
      ) : (
        <div>
          <label className={lbl}>Label</label>
          <input className={input} value={field.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} />
        </div>
      )}

      {!isLayout ? (
        <>
          <div>
            <label className={lbl}>Help text</label>
            <input className={input} value={field.help ?? ''} placeholder="Optional hint shown under the field" onChange={(e) => onPatch({ help: e.target.value || undefined })} />
          </div>
          {(field.type === 'text' || field.type === 'textarea' || field.type === 'email' || field.type === 'tel' || field.type === 'number') ? (
            <div>
              <label className={lbl}>Placeholder</label>
              <input className={input} value={field.placeholder ?? ''} onChange={(e) => onPatch({ placeholder: e.target.value || undefined })} />
            </div>
          ) : null}
          <label className="flex items-center justify-between text-sm text-slate-700">
            Required
            <input type="checkbox" checked={!!field.required} onChange={(e) => onPatch({ required: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-emerald-600" />
          </label>
          <label className="flex items-center justify-between text-sm text-slate-700">
            Locked (read-only)
            <input type="checkbox" checked={!!field.readOnly} onChange={(e) => onPatch({ readOnly: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-emerald-600" />
          </label>
        </>
      ) : null}

      {hasOptions ? (
        <div>
          <label className={lbl}>Options</label>
          <div className="space-y-1.5">
            {(field.options ?? []).map((o, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input className={input} value={o.label}
                  onChange={(e) => {
                    const opts = [...(field.options ?? [])];
                    opts[i] = { ...opts[i], label: e.target.value, value: slugify(e.target.value) || `option_${i + 1}` };
                    onPatch({ options: opts });
                  }} />
                <button onClick={() => onPatch({ options: (field.options ?? []).filter((_, j) => j !== i) })}
                  className="shrink-0 text-slate-300 hover:text-rose-500"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
          <button onClick={() => onPatch({ options: [...(field.options ?? []), { value: `option_${(field.options?.length ?? 0) + 1}`, label: '' }] })}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
            <Plus className="h-3.5 w-3.5" /> Add option
          </button>
        </div>
      ) : null}

      {!isLayout ? (
        <div>
          <label className={lbl}>Growth Suite field</label>
          {field.ghl_field_key ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-800">
              <span className="inline-flex items-center gap-1.5 truncate"><Plug className="h-3.5 w-3.5 shrink-0" />{String(field.ghl_field_key)}</span>
              <button onClick={() => onConnect(null)} className="shrink-0 text-blue-500 hover:text-blue-700" title="Disconnect"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : ghlFields.length > 0 ? (
            <select className={input} value="" onChange={(e) => { const g = ghlFields.find((x) => x.key === e.target.value); if (g) onConnect(g); }}>
              <option value="">Not connected — pick a field…</option>
              {ghlFields.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
            </select>
          ) : (
            <p className="text-[11px] text-slate-400">No Growth Suite fields available.</p>
          )}
          <p className="mt-1 text-[11px] text-slate-400">Connected fields pre-fill from the contact record and save the answer back to it.</p>
        </div>
      ) : null}

      <div className="border-t border-slate-100 pt-3">
        <label className={lbl}>Show this field when</label>
        <ConditionEditor field={field} allFields={allFields} onPatch={onPatch} input={input} />
      </div>
    </div>
  );
}

function ConditionEditor({ field, allFields, onPatch, input }: {
  field: FieldBlock; allFields: FieldBlock[];
  onPatch: (patch: Partial<FieldBlock>) => void; input: string;
}) {
  const vw = field.visible_when;
  const candidates = allFields.filter((f) => f.key && f.key !== field.key && f.type !== 'section' && f.type !== 'paragraph');

  if (!vw) {
    if (candidates.length === 0) {
      return <p className="text-[11px] text-slate-400">Always shown — add another field first to build a rule.</p>;
    }
    return (
      <div>
        <p className="mb-2 text-[11px] text-slate-500">Always shown.</p>
        <button onClick={() => onPatch({ visible_when: { field: candidates[0].key as string, equals: [] } })}
          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
          <Plus className="h-3.5 w-3.5" /> Add a rule
        </button>
      </div>
    );
  }

  const ref = allFields.find((f) => f.key === vw.field);
  const refOptions: Option[] = ref?.options ?? (ref?.type === 'checkbox' ? [{ value: '1', label: 'Checked' }] : []);
  const toggle = (v: string) => {
    const set = new Set(vw.equals);
    if (set.has(v)) set.delete(v); else set.add(v);
    onPatch({ visible_when: { field: vw.field, equals: [...set] } });
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2.5">
      <select className={input} value={vw.field} onChange={(e) => onPatch({ visible_when: { field: e.target.value, equals: [] } })}>
        {candidates.map((f) => <option key={f.key} value={f.key as string}>{f.label || f.key}</option>)}
      </select>
      <p className="text-[11px] text-slate-500">is any of</p>
      {refOptions.length > 0 ? (
        <div className="space-y-1">
          {refOptions.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={vw.equals.includes(o.value)} onChange={() => toggle(o.value)} className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600" />
              {o.label || o.value}
            </label>
          ))}
        </div>
      ) : (
        <input className={input} value={vw.equals.join(', ')} placeholder="Comma-separated values"
          onChange={(e) => onPatch({ visible_when: { field: vw.field, equals: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
      )}
      <button onClick={() => onPatch({ visible_when: undefined })}
        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-500">
        <X className="h-3 w-3" /> Remove rule
      </button>
    </div>
  );
}

function FormSettingsPanel({ settings, onPatch }: { settings: FormSettings; onPatch: (patch: Partial<FormSettings>) => void }) {
  const input = 'w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';
  const lbl = 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400';
  const toggle = 'flex items-center justify-between text-sm text-slate-700';
  const cb = 'h-4 w-4 rounded border-slate-300 text-emerald-600';
  return (
    <div className="space-y-4">
      <div className="text-xs font-semibold text-slate-800">Form settings</div>
      <div>
        <label className={lbl}>Form name</label>
        <input className={input} value={settings.display_name} onChange={(e) => onPatch({ display_name: e.target.value })} />
      </div>
      <div>
        <label className={lbl}>Description</label>
        <input className={input} value={settings.description ?? ''} onChange={(e) => onPatch({ description: e.target.value || null })} />
      </div>
      <div>
        <label className={lbl}>Confirmation message</label>
        <textarea rows={4} className={input} value={settings.confirmation_message ?? ''} placeholder="Shown to the parent after they submit" onChange={(e) => onPatch({ confirmation_message: e.target.value || null })} />
      </div>
      <div>
        <label className={lbl}>Notify on submit</label>
        <input className={input} value={settings.notify_emails.join(', ')} placeholder="office@school.org, admissions@school.org"
          onChange={(e) => onPatch({ notify_emails: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        <p className="mt-1 text-[11px] text-slate-400">Comma-separated. Blank = no notification.</p>
      </div>
      <label className={toggle}>One form per student<input type="checkbox" checked={settings.per_student} onChange={(e) => onPatch({ per_student: e.target.checked })} className={cb} /></label>
      <label className={toggle}>Allow re-submission<input type="checkbox" checked={settings.resubmission_allowed} onChange={(e) => onPatch({ resubmission_allowed: e.target.checked })} className={cb} /></label>
      <label className={toggle}>Form is live<input type="checkbox" checked={settings.is_active} onChange={(e) => onPatch({ is_active: e.target.checked })} className={cb} /></label>
    </div>
  );
}
