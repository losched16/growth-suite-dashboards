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
  Pencil, Users,
} from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Option { value: string; label: string; amount_cents?: number }
// One conditional test (mirrors the portal's VisibilityCondition).
// `source:'prefill'` → `field` is a GHL/catalog fact (a `meta:<key>` prefill
// source) read from the family's data, not an answer on this form.
export interface VisCondition { field: string; equals: string[]; source?: 'field' | 'prefill' }
// Block-level conditional visibility. Legacy single `{ field, equals }` OR
// multi `{ match, conditions }` (AND / OR). Must stay in sync with the portal
// (lib/forms/types.ts + prefill.ts isBlockVisible). The builder only writes
// the multi shape for 2+ conditions, so single rules keep the legacy shape.
export type VisibleWhen =
  | VisCondition
  | { match: 'all' | 'any'; conditions: VisCondition[] };

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
  visible_when?: VisibleWhen;
  prefill?: string;
  ghl_field_key?: string;
  _uid?: string;
  [k: string]: unknown;
}

// Normalize either visible_when shape into an editable {match, conditions}.
function readRule(vw: VisibleWhen | undefined): { match: 'all' | 'any'; conditions: VisCondition[] } | null {
  if (!vw) return null;
  if ('conditions' in vw) {
    return { match: vw.match === 'any' ? 'any' : 'all', conditions: Array.isArray(vw.conditions) ? vw.conditions : [] };
  }
  if (vw.field) return { match: 'all', conditions: [{ field: vw.field, equals: vw.equals ?? [] }] };
  return null;
}
// Serialize back: drop empty conditions. A single IN-FORM condition collapses
// to the legacy `{field,equals}` shape (byte-identical, nothing to migrate); a
// single PREFILL condition keeps the multi shape so its `source` survives.
function writeRule(match: 'all' | 'any', conditions: VisCondition[]): VisibleWhen | undefined {
  const clean = conditions.filter((c) => c.field).map((c) =>
    c.source === 'prefill' ? { field: c.field, equals: c.equals, source: 'prefill' as const } : { field: c.field, equals: c.equals });
  if (clean.length === 0) return undefined;
  if (clean.length === 1 && !('source' in clean[0])) return { field: clean[0].field, equals: clean[0].equals };
  return { match, conditions: clean };
}
// Evaluate a rule against live answers — mirror of the portal's isBlockVisible.
// A prefill-sourced condition reads the simulated fact under `@prefill:<field>`.
function evalRule(vw: VisibleWhen | undefined, answers: Record<string, string | string[]>): boolean {
  const rule = readRule(vw);
  if (!rule || rule.conditions.length === 0) return true;
  const one = (c: VisCondition) => {
    const cur = answers[c.source === 'prefill' ? `@prefill:${c.field}` : c.field];
    const vals = Array.isArray(cur) ? cur : cur == null || cur === '' ? [] : [cur];
    return c.equals.some((e) => vals.includes(e));
  };
  const res = rule.conditions.map(one);
  return rule.match === 'any' ? res.some(Boolean) : res.every(Boolean);
}

// Distinct prefill (GHL-fact) sources referenced by any field's rule, with the
// union of values each is tested against — powers the preview "simulate" panel.
function prefillSourcesInForm(fields: FieldBlock[]): Array<{ source: string; values: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const f of fields) {
    const rule = readRule(f.visible_when);
    if (!rule) continue;
    for (const c of rule.conditions) {
      if (c.source !== 'prefill' || !c.field) continue;
      if (!map.has(c.field)) map.set(c.field, new Set());
      for (const v of c.equals) map.get(c.field)!.add(v);
    }
  }
  return [...map.entries()].map(([source, vals]) => ({ source, values: [...vals] }));
}

export interface GhlField { key: string; name: string; dataType: string; options: string[] }

// Per-student visibility rule (portal_form_definitions.applies_to). null / {}
// → the form shows for every student. We only surface program / grade / tag
// targeting in the UI; any other criteria already on the rule pass through
// untouched so advanced targeting set elsewhere is never clobbered.
export interface FormAppliesTo {
  program_match?: string[];
  tag_match?: string[];
  tuition_grid_match?: string[];
  addon_keys?: string[];
  student_ids?: string[];
  metadata_match?: Record<string, string[]>;
  // Exclusion: families carrying any of these tags never see the form,
  // regardless of the inclusion rules (office pushes still override).
  tag_exclude?: string[];
}

export interface FormSettings {
  display_name: string;
  description: string | null;
  confirmation_message: string | null;
  notify_emails: string[];
  per_student: boolean;
  resubmission_allowed: boolean;
  is_active: boolean;
  applies_to: FormAppliesTo | null;
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
  { group: 'Sign', type: 'signature_typed', label: 'Signature (typed)', icon: <PenLine className="h-4 w-4" /> },
  { group: 'Sign', type: 'signature_drawn', label: 'Signature (draw or type)', icon: <PenLine className="h-4 w-4" /> },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(PALETTE.map((p) => [p.type, p.label]));
const HAS_OPTIONS = new Set(['select', 'radio']);

// Canonical Growth Suite prefill sources — read straight from the student /
// parent record (not a GHL custom field), so they always resolve with no
// key-matching. Read-only by default (they show what's on file); the operator
// can unlock a field if they want parents to be able to edit it. These are
// display/prefill only — no writeback (you can't save a composed full name
// back to a single field).
const BUILTIN_SOURCES: Array<{ source: string; label: string; type: PaletteType }> = [
  { source: 'student.full_name', label: 'Student full name', type: 'text' },
  { source: 'student.first_name', label: 'Student first name', type: 'text' },
  { source: 'student.last_name', label: 'Student last name', type: 'text' },
  { source: 'student.date_of_birth', label: 'Student date of birth', type: 'date' },
  { source: 'student.age', label: 'Student age', type: 'number' },
  { source: 'parent.full_name', label: 'Parent/Guardian full name', type: 'text' },
  { source: 'parent.first_name', label: 'Parent first name', type: 'text' },
  { source: 'parent.last_name', label: 'Parent last name', type: 'text' },
  { source: 'parent.email', label: 'Parent email', type: 'email' },
  { source: 'parent.phone', label: 'Parent phone', type: 'tel' },
  { source: 'today', label: "Today's date", type: 'date' },
];
const BUILTIN_LABEL: Record<string, string> = Object.fromEntries(BUILTIN_SOURCES.map((s) => [s.source, s.label]));

// Stable client-only id per field so dnd-kit can track it across reorders.
// Stripped from the payload on save (never persisted).
let _uidSeq = 0;
const nextUid = () => `u${++_uidSeq}`;

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

// The equivalent key forms the sync may store a per-student contact field
// under. GHL keys come bare (`street`), slot-1-bare (`student_street`), or
// numbered (`student_2_grade_level`); the sync mirrors the value under one of
// these. We try the siblings so the prefill key we stamp is one that resolves.
function metaKeyCandidates(key: string): string[] {
  const out = [key];
  const m = /^student_(\d+)_(.+)$/.exec(key);
  if (m) {
    out.push(m[2]);                              // student_2_grade_level → grade_level
    if (m[1] === '1') out.push(`student_${m[2]}`);
  } else if (key.startsWith('student_')) {
    const b = key.slice('student_'.length);
    out.push(b, `student_1_${b}`);               // student_street → street / student_1_street
  } else {
    out.push(`student_${key}`, `student_1_${key}`); // street → student_street / student_1_street
  }
  return out;
}

// Pick the prefill key that actually exists in the roster's metadata, so a
// connected field reliably pre-fills from the contact record regardless of the
// school's field-naming convention. Falls back to the raw key when we have no
// roster keys to match against (e.g. a brand-new school with no data yet).
function resolvePrefillKey(rawKey: string, metadataKeys: string[]): string {
  if (metadataKeys.length === 0) return rawKey;
  const have = new Set(metadataKeys);
  for (const c of metaKeyCandidates(rawKey)) if (have.has(c)) return c;
  return rawKey;
}

// Connect a field to a Growth Suite (GHL) contact field: it prefills from the
// contact record (meta:<key>) and inherits the field's type + choices. The
// prefill key is alias-matched to a real roster metadata key; writeback always
// targets the raw GHL field key (they can legitimately differ).
function connectFieldTo(f: FieldBlock, gf: GhlField, metadataKeys: string[]): FieldBlock {
  const type = inferType(gf.dataType);
  const prefillKey = resolvePrefillKey(gf.key, metadataKeys);
  const next: FieldBlock = { ...f, type, prefill: `meta:${prefillKey}`, ghl_field_key: gf.key };
  if (!next.label || next.label === TYPE_LABEL[f.type]) next.label = gf.name;
  if (type === 'select' && gf.options.length) {
    next.options = gf.options.map((o) => ({ value: slugify(o) || o, label: o }));
  }
  return next;
}

export function FormBuilderV2({
  schoolId, formId, slug, initialSchema, initialSettings, ghlFields, metadataKeys = [],
  programOptions = [], gradeOptions = [], tagOptions = [], studentOptions = [], previewHref, backHref,
}: {
  schoolId: string;
  formId: string;
  slug: string;
  displayName: string;
  initialSchema: FieldBlock[];
  initialSettings: FormSettings;
  ghlFields: GhlField[];
  metadataKeys?: string[];
  programOptions?: string[];
  gradeOptions?: string[];
  tagOptions?: string[];
  studentOptions?: Array<{ id: string; name: string; program: string | null }>;
  previewHref: string;
  backHref: string;
}) {
  const [ghlSearch, setGhlSearch] = useState('');
  const [settings, setSettings] = useState<FormSettings>(initialSettings);
  const [fields, setFields] = useState<FieldBlock[]>(() => initialSchema.map((f) => ({ ...f, _uid: nextUid() })));
  const [sel, setSel] = useState<number | null>(null);
  // Inline live preview — renders the form as a parent sees it, with the
  // conditional-logic rules actually working so operators can test them.
  const [preview, setPreview] = useState(false);
  const [pans, setPans] = useState<Record<string, string | string[]>>({});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const keys = new Set(fields.map((f) => f.key).filter(Boolean) as string[]);

  function mutate(next: FieldBlock[]) { setFields(next); setDirty(true); setSavedAt(null); }
  function patchSettings(patch: Partial<FormSettings>) { setSettings((s) => ({ ...s, ...patch })); setDirty(true); setSavedAt(null); }
  function addField(type: PaletteType) {
    const f = { ...makeField(type, keys), _uid: nextUid() };
    mutate([...fields, f]);
    setSel(fields.length);
  }
  function addGhlField(gf: GhlField) {
    const f = { ...connectFieldTo(makeField(inferType(gf.dataType), keys), gf, metadataKeys), _uid: nextUid() };
    mutate([...fields, f]);
    setSel(fields.length);
  }
  function addBuiltinSource(src: { source: string; label: string; type: PaletteType }) {
    let key = slugify(src.label) || 'field';
    let n = 1;
    while (keys.has(key)) key = `${slugify(src.label)}_${++n}`;
    const f: FieldBlock = { type: src.type, key, label: src.label, prefill: src.source, readOnly: true, _uid: nextUid() };
    mutate([...fields, f]);
    setSel(fields.length);
  }
  function connectSelected(gf: GhlField | null) {
    if (sel == null) return;
    mutate(fields.map((f, j) => {
      if (j !== sel) return f;
      if (gf) return connectFieldTo(f, gf, metadataKeys);
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
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex((f) => f._uid === active.id);
    const to = fields.findIndex((f) => f._uid === over.id);
    if (from < 0 || to < 0) return;
    mutate(arrayMove(fields, from, to));
    setSel(to);
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field_schema: fields.map((f) => { const { _uid: _u, ...rest } = f; void _u; return rest; }),
          meta: {
            display_name: settings.display_name,
            description: settings.description,
            confirmation_message: settings.confirmation_message,
            notify_emails: settings.notify_emails,
            per_student: settings.per_student,
            resubmission_allowed: settings.resubmission_allowed,
            is_active: settings.is_active,
            applies_to: settings.applies_to,
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
          {/* Build / Preview toggle — swaps the canvas between the editor and a
              live rendering of the form (conditional logic runs for real). */}
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300">
            <button onClick={() => setPreview(false)}
              className={['inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium', !preview ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'].join(' ')}>
              <Pencil className="h-3.5 w-3.5" /> Build
            </button>
            <button onClick={() => setPreview(true)}
              className={['inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium', preview ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'].join(' ')}>
              <Eye className="h-3.5 w-3.5" /> Preview
            </button>
          </div>
          <button onClick={() => setSel(null)}
            className={['inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium', sel === null ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'].join(' ')}>
            <SettingsIcon className="h-3.5 w-3.5" /> Settings
          </button>
          {err ? <span className="text-xs text-red-600">{err}</span>
            : savedAt ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" /> Saved</span>
            : dirty ? <span className="text-xs text-amber-600">Unsaved changes</span> : null}
          <a href={previewHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50" title="Open the full portal preview in a new tab">
            <Eye className="h-3.5 w-3.5" /> Full preview
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
          <div className="mb-4">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Prefill from record</p>
            {BUILTIN_SOURCES.map((s) => (
              <button key={s.source} onClick={() => addBuiltinSource(s)} title={`Pre-fills from ${s.source}`}
                className="mb-1 flex w-full items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5 text-left text-xs font-medium text-emerald-800 hover:bg-emerald-50">
                <Plug className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{s.label}</span>
              </button>
            ))}
          </div>
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
          <div className="mx-auto max-w-2xl">
            {preview ? (
              <FormPreview fields={fields} settings={settings} answers={pans} setAnswers={setPans} />
            ) : fields.length === 0 ? (
              <div className="rounded-lg border-2 border-dashed border-slate-300 py-16 text-center text-sm text-slate-400">
                Add a field from the left to get started.
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={fields.map((f) => f._uid as string)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {fields.map((f, i) => (
                      <SortableFieldCard key={f._uid} field={f} selected={sel === i} onSelect={() => setSel(i)} onDelete={() => deleteField(i)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
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
              metadataKeys={metadataKeys}
              onPatch={(patch) => sel != null && patchField(sel, patch)}
              onConnect={connectSelected}
            />
          ) : (
            <FormSettingsPanel settings={settings} onPatch={patchSettings}
              programOptions={programOptions} gradeOptions={gradeOptions} tagOptions={tagOptions} studentOptions={studentOptions} />
          )}
        </aside>
      </div>
    </div>
  );
}

function SortableFieldCard({ field, selected, onSelect, onDelete }: {
  field: FieldBlock; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field._uid as string });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const isLayout = field.type === 'section' || field.type === 'paragraph';
  return (
    <div ref={setNodeRef} style={style} onClick={onSelect}
      className={[
        'group flex items-center gap-2 rounded-lg border bg-white px-3 py-2.5 cursor-pointer',
        selected ? 'border-emerald-500 ring-1 ring-emerald-500' : 'border-slate-200 hover:border-slate-300',
        isDragging ? 'shadow-lg' : '',
      ].join(' ')}
    >
      <button {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}
        className="shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing" aria-label="Drag to reorder">
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className={isLayout ? 'text-sm font-semibold text-slate-800' : 'text-sm font-medium text-slate-900 truncate'}>
          {field.type === 'paragraph' ? (field.text || 'Text block') : (field.label || '(untitled)')}
          {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
        </p>
        {!isLayout ? (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {TYPE_LABEL[field.type] ?? field.type}
            {field.prefill ? ' · linked to GHL' : ''}
            {field.visible_when ? ' · conditional' : ''}
            {field.readOnly ? ' · locked' : ''}
          </p>
        ) : null}
      </div>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="shrink-0 text-slate-300 opacity-0 hover:text-rose-500 group-hover:opacity-100" title="Delete field">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function Inspector({ field, allFields, ghlFields, metadataKeys, onPatch, onConnect }: { field: FieldBlock; allFields: FieldBlock[]; ghlFields: GhlField[]; metadataKeys: string[]; onPatch: (patch: Partial<FieldBlock>) => void; onConnect: (gf: GhlField | null) => void }) {
  const isLayout = field.type === 'section' || field.type === 'paragraph';
  const hasOptions = HAS_OPTIONS.has(field.type);
  // A canonical record source (student.*, parent.*, today) — set as prefill
  // with no ghl_field_key (read-only, no writeback), distinct from a meta:<key>
  // GHL-custom-field connection.
  const builtinSource = !field.ghl_field_key && typeof field.prefill === 'string' && !field.prefill.startsWith('meta:')
    ? field.prefill : null;
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
          ) : builtinSource ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
              <span className="inline-flex items-center gap-1.5 truncate"><Plug className="h-3.5 w-3.5 shrink-0" />{BUILTIN_LABEL[builtinSource] ?? builtinSource}</span>
              <button onClick={() => onPatch({ prefill: undefined })} className="shrink-0 text-emerald-600 hover:text-emerald-800" title="Disconnect"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : ghlFields.length > 0 ? (
            <select className={input} value="" onChange={(e) => { const g = ghlFields.find((x) => x.key === e.target.value); if (g) onConnect(g); }}>
              <option value="">Not connected — pick a field…</option>
              {ghlFields.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
            </select>
          ) : (
            <p className="text-[11px] text-slate-400">No Growth Suite fields available.</p>
          )}
          {builtinSource ? (
            <p className="mt-1 text-[11px] text-emerald-700">Pre-fills from the record (read-only). Uncheck “Locked” above to let parents edit it.</p>
          ) : field.ghl_field_key && typeof field.prefill === 'string' && field.prefill.startsWith('meta:') ? (
            <p className="mt-1 text-[11px] text-emerald-700">Pre-fills from <span className="font-mono">{field.prefill.slice('meta:'.length)}</span> and saves back to the contact.</p>
          ) : (
            <p className="mt-1 text-[11px] text-slate-400">Connected fields pre-fill from the contact record and save the answer back to it.</p>
          )}
        </div>
      ) : null}

      <div className="border-t border-slate-100 pt-3">
        <label className={lbl}>Show this field when</label>
        <ConditionEditor field={field} allFields={allFields} ghlFields={ghlFields} metadataKeys={metadataKeys} onPatch={onPatch} input={input} />
      </div>
    </div>
  );
}

function ConditionEditor({ field, allFields, ghlFields, metadataKeys, onPatch, input }: {
  field: FieldBlock; allFields: FieldBlock[]; ghlFields: GhlField[]; metadataKeys: string[];
  onPatch: (patch: Partial<FieldBlock>) => void; input: string;
}) {
  const rule = readRule(field.visible_when);
  const candidates = allFields.filter((f) => f.key && f.key !== field.key && f.type !== 'section' && f.type !== 'paragraph');

  // A GHL fact's condition `field` is the same `meta:<key>` prefill source the
  // renderer resolves — so reuse the exact key alias-matching used for prefill.
  const metaKeyFor = (gf: GhlField) => `meta:${resolvePrefillKey(gf.key, metadataKeys)}`;
  const gfForCond = (c: VisCondition) => c.source === 'prefill' ? ghlFields.find((g) => metaKeyFor(g) === c.field) : undefined;
  const defaultCond = (): VisCondition =>
    candidates[0]?.key ? { field: candidates[0].key, equals: [] }
      : ghlFields[0] ? { field: metaKeyFor(ghlFields[0]), equals: [], source: 'prefill' }
      : { field: '', equals: [] };
  const canBuild = candidates.length > 0 || ghlFields.length > 0;

  if (!rule) {
    if (!canBuild) return <p className="text-[11px] text-slate-400">Always shown — add another field first to build a rule.</p>;
    return (
      <div>
        <p className="mb-2 text-[11px] text-slate-500">Always shown.</p>
        <button onClick={() => onPatch({ visible_when: writeRule('all', [defaultCond()]) })}
          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
          <Plus className="h-3.5 w-3.5" /> Add a rule
        </button>
      </div>
    );
  }

  const { match, conditions } = rule;
  const commit = (m: 'all' | 'any', cs: VisCondition[]) => onPatch({ visible_when: writeRule(m, cs) });
  const setCond = (i: number, patch: Partial<VisCondition>) =>
    commit(match, conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  // Picking from the "Facts we know" group prefixes the value with @ghl:.
  const onPickField = (i: number, value: string) => {
    if (value.startsWith('@ghl:')) {
      const gf = ghlFields.find((g) => g.key === value.slice(5));
      if (gf) setCond(i, { field: metaKeyFor(gf), equals: [], source: 'prefill' });
    } else {
      setCond(i, { field: value, equals: [], source: 'field' });
    }
  };
  const selectValue = (c: VisCondition) => {
    if (c.source === 'prefill') { const gf = gfForCond(c); return gf ? `@ghl:${gf.key}` : ''; }
    return c.field;
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2.5">
      {conditions.length > 1 ? (
        <div className="flex items-center gap-2 text-[11px] text-slate-600">
          <span>Match</span>
          <select className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px]" value={match}
            onChange={(e) => commit(e.target.value === 'any' ? 'any' : 'all', conditions)}>
            <option value="all">all conditions (AND)</option>
            <option value="any">any condition (OR)</option>
          </select>
        </div>
      ) : null}

      {conditions.map((c, i) => {
        // Value options for the "is any of" picker: for a GHL fact use that
        // field's picklist; for an in-form field use its options.
        let refOptions: Option[] = [];
        if (c.source === 'prefill') {
          const gf = gfForCond(c);
          refOptions = gf ? gf.options.map((o) => ({ value: o, label: o })) : [];
        } else {
          const ref = allFields.find((f) => f.key === c.field);
          refOptions = ref?.options ?? (ref?.type === 'checkbox' ? [{ value: '1', label: 'Checked' }] : []);
        }
        const toggle = (v: string) => {
          const set = new Set(c.equals);
          if (set.has(v)) set.delete(v); else set.add(v);
          setCond(i, { equals: [...set] });
        };
        return (
          <div key={i} className={i > 0 ? 'space-y-2 border-t border-slate-200 pt-2' : 'space-y-2'}>
            {i > 0 ? (
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{match === 'any' ? 'or' : 'and'}</p>
            ) : null}
            <select className={input} value={selectValue(c)} onChange={(e) => onPickField(i, e.target.value)}>
              {candidates.length > 0 ? (
                <optgroup label="Fields on this form">
                  {candidates.map((f) => <option key={f.key} value={f.key as string}>{f.label || f.key}</option>)}
                </optgroup>
              ) : null}
              {ghlFields.length > 0 ? (
                <optgroup label="Facts we know (from GHL)">
                  {ghlFields.map((g) => <option key={g.key} value={`@ghl:${g.key}`}>{g.name}</option>)}
                </optgroup>
              ) : null}
            </select>
            {c.source === 'prefill' ? (
              <p className="text-[10px] text-emerald-700">A fact we already know about the family — no question added to the form.</p>
            ) : null}
            <p className="text-[11px] text-slate-500">is any of</p>
            {refOptions.length > 0 ? (
              <div className="space-y-1">
                {refOptions.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-xs text-slate-700">
                    <input type="checkbox" checked={c.equals.includes(o.value)} onChange={() => toggle(o.value)} className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600" />
                    {o.label || o.value}
                  </label>
                ))}
              </div>
            ) : (
              <input className={input} value={c.equals.join(', ')} placeholder="Comma-separated values"
                onChange={(e) => setCond(i, { equals: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            )}
            {conditions.length > 1 ? (
              <button onClick={() => commit(match, conditions.filter((_, j) => j !== i))}
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-500">
                <X className="h-3 w-3" /> Remove this condition
              </button>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center justify-between border-t border-slate-200 pt-2">
        <button onClick={() => commit(match, [...conditions, defaultCond()])}
          disabled={!canBuild}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline disabled:text-slate-300 disabled:no-underline">
          <Plus className="h-3 w-3" /> Add condition
        </button>
        <button onClick={() => onPatch({ visible_when: undefined })}
          className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-500">
          <X className="h-3 w-3" /> Remove rule
        </button>
      </div>
    </div>
  );
}

// Live, in-canvas rendering of the form as a parent sees it. Choice inputs are
// interactive so the conditional-logic rules run for real — an operator can pick
// an option and watch dependent fields appear/disappear. Nothing is submitted.
type PreviewAnswers = Record<string, string | string[]>;
function FormPreview({ fields, settings, answers, setAnswers }: {
  fields: FieldBlock[]; settings: FormSettings;
  answers: PreviewAnswers; setAnswers: (u: (a: PreviewAnswers) => PreviewAnswers) => void;
}) {
  const set = (key: string, value: string | string[]) => setAnswers((a) => ({ ...a, [key]: value }));
  const visible = (f: FieldBlock): boolean => evalRule(f.visible_when, answers);
  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-slate-50 disabled:text-slate-500';
  const muted = 'rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-xs text-slate-500';
  // GHL facts any rule gates on — real families supply these at runtime; here
  // the operator sets them by hand to watch the conditional logic react.
  const simSources = prefillSourcesInForm(fields);

  const shown = fields.filter(visible);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{settings.display_name}</h2>
      {settings.description ? <p className="mt-1 text-sm text-slate-500">{settings.description}</p> : null}
      {simSources.length > 0 ? (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">Simulate family data</p>
          <p className="mb-2 text-[11px] text-emerald-700">These facts come from GHL for the real family — set them here to test your rules.</p>
          <div className="space-y-2">
            {simSources.map((s) => {
              const cur = answers[`@prefill:${s.source}`];
              return (
                <label key={s.source} className="block text-xs font-medium text-slate-700">
                  {s.source.replace(/^meta:/, '').replace(/_/g, ' ')}
                  <select className={input} value={typeof cur === 'string' ? cur : ''} onChange={(e) => set(`@prefill:${s.source}`, e.target.value)}>
                    <option value="">— not set —</option>
                    {s.values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mt-5 space-y-5">
        {shown.length === 0 ? <p className="text-sm text-slate-400">Nothing to show yet.</p> : null}
        {shown.map((f, i) => {
          if (f.type === 'header') return <h2 key={i} className="text-base font-bold text-slate-900">{f.label}</h2>;
          if (f.type === 'section') return <h3 key={i} className="border-b border-slate-100 pb-1 text-sm font-semibold uppercase tracking-wide text-slate-700">{f.label}</h3>;
          if (f.type === 'paragraph') return <p key={i} className="whitespace-pre-wrap text-sm text-slate-600">{f.text}</p>;
          const key = f.key ?? `f${i}`;
          const val = answers[key];
          const strVal = typeof val === 'string' ? val : '';
          const arrVal = Array.isArray(val) ? val : [];
          const help = f.help ? <p className="mt-1 text-xs text-slate-400">{String(f.help)}</p> : null;
          // In the sandbox there's no real record data, so hint what a prefilled
          // read-only field will show live (e.g. the student's name).
          const ph = f.readOnly && f.prefill
            ? `— pre-filled: ${(typeof f.prefill === 'string' && (BUILTIN_LABEL[f.prefill] || (f.prefill.startsWith('meta:') ? f.prefill.slice(5) : f.prefill))) || 'from record'} —`
            : String(f.placeholder ?? '');
          const label = (
            <label className="mb-1 block text-sm font-medium text-slate-800">
              {f.label}{f.required ? <span className="ml-0.5 text-rose-500">*</span> : null}
              {f.readOnly ? <span className="ml-1.5 align-middle text-slate-400" title="Read-only">🔒</span> : null}
            </label>
          );
          const dis = !!f.readOnly;

          if (f.type === 'checkbox') {
            return (
              <div key={i}>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" disabled={dis} checked={strVal === '1'} onChange={(e) => set(key, e.target.checked ? '1' : '')} className="mt-0.5 h-4 w-4 rounded text-emerald-600" />
                  <span>{f.label}{f.required ? <span className="ml-0.5 text-rose-500">*</span> : null}</span>
                </label>
                {help}
              </div>
            );
          }

          let control: React.ReactNode;
          switch (f.type) {
            case 'textarea':
              control = <textarea rows={3} disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'select':
              control = (
                <select disabled={dis} className={input} value={strVal} onChange={(e) => set(key, e.target.value)}>
                  <option value="">Select…</option>
                  {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              );
              break;
            case 'radio':
              control = (
                <div className="space-y-1.5">
                  {(f.options ?? []).map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="radio" name={key} disabled={dis} checked={strVal === o.value} onChange={() => set(key, o.value)} className="h-4 w-4 text-emerald-600" />
                      {o.label}
                    </label>
                  ))}
                </div>
              );
              break;
            case 'multi_checkbox':
              control = (
                <div className="space-y-1.5">
                  {(f.options ?? []).map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" disabled={dis} checked={arrVal.includes(o.value)}
                        onChange={() => set(key, arrVal.includes(o.value) ? arrVal.filter((x) => x !== o.value) : [...arrVal, o.value])}
                        className="h-4 w-4 rounded text-emerald-600" />
                      {o.label}
                    </label>
                  ))}
                </div>
              );
              break;
            case 'date':
              control = <input type="date" disabled={dis} className={input} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'number':
              control = <input type="number" disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'email':
              control = <input type="email" disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'tel':
              control = <input type="tel" disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'url':
              control = <input type="url" disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
              break;
            case 'signature_typed':
              control = (
                <div className="flex items-center gap-2">
                  <input disabled={dis} className={input} placeholder="Type your full name" value={strVal} onChange={(e) => set(key, e.target.value)} />
                  <span className="shrink-0 text-xs text-slate-400">Date auto-stamped</span>
                </div>
              );
              break;
            case 'signature_drawn': case 'signature_stamp':
              control = <div className={muted}>Signature captured here in the live form.</div>;
              break;
            case 'file_upload':
              control = <input type="file" disabled className="block w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs" />;
              break;
            case 'pricing_select': case 'multi_pricing': case 'quantity_pricing': case 'tuition_calculator': case 'student_picker':
              control = <div className={muted}>{TYPE_LABEL[f.type] ?? 'Interactive'} options appear here in the live form.</div>;
              break;
            default:
              control = <input type="text" disabled={dis} className={input} placeholder={ph} value={strVal} onChange={(e) => set(key, e.target.value)} />;
          }
          return <div key={i}>{label}{control}{help}</div>;
        })}
      </div>
      <div className="mt-6 border-t border-slate-100 pt-4">
        <button disabled className="cursor-default rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white opacity-90">Submit</button>
        <p className="mt-2 text-[11px] text-slate-400">Preview only — nothing is submitted. Pick options to watch your conditional rules run.</p>
      </div>
    </div>
  );
}

function WhoSeesEditor({ settings, onPatch, programOptions, gradeOptions, tagOptions, studentOptions }: {
  settings: FormSettings; onPatch: (patch: Partial<FormSettings>) => void;
  programOptions: string[]; gradeOptions: string[]; tagOptions: string[];
  studentOptions: Array<{ id: string; name: string; program: string | null }>;
}) {
  const at = settings.applies_to ?? {};
  const programs = at.program_match ?? [];
  const grades = at.metadata_match?.grade_level ?? [];
  const tags = at.tag_match ?? [];
  const studentIds = at.student_ids ?? [];
  const excl = at.tag_exclude ?? [];
  // Exclusion deliberately does NOT count as a "rule": "Everyone (except
  // tagged-out families)" keeps the Everyone radio selected.
  const hasRule = programs.length > 0 || grades.length > 0 || tags.length > 0 || studentIds.length > 0;
  // Student search for the "Specific students" picker.
  const [stuSearch, setStuSearch] = useState('');

  // Checklists = roster values + any value the rule already names (so a
  // renamed/removed program stays visible and removable).
  const progList = Array.from(new Set([...programOptions, ...programs]));
  const gradeList = Array.from(new Set([...gradeOptions, ...grades]));
  const tagList = Array.from(new Set([...tagOptions, ...tags]));
  // Program/grade are per-student attributes; tags are family-level.
  const showProgram = (settings.per_student && programOptions.length > 0) || programs.length > 0;
  const showGrade = (settings.per_student && gradeOptions.length > 0) || grades.length > 0;
  const showTag = tagList.length > 0;

  function apply(next: { programs?: string[]; grades?: string[]; tags?: string[] }) {
    const p = next.programs ?? programs;
    const g = next.grades ?? grades;
    const t = next.tags ?? tags;
    const base: FormAppliesTo = { ...(settings.applies_to ?? {}) };
    delete base.program_match; delete base.tag_match;
    const mm: Record<string, string[]> = { ...(base.metadata_match ?? {}) };
    delete mm.grade_level;
    if (p.length) base.program_match = p;
    if (t.length) base.tag_match = t;
    if (g.length) mm.grade_level = g;
    if (Object.keys(mm).length) base.metadata_match = mm; else delete base.metadata_match;
    onPatch({ applies_to: Object.keys(base).length === 0 ? null : base });
  }
  const toggleIn = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const cb = 'h-3.5 w-3.5 rounded border-slate-300 text-emerald-600';

  // Specific-student targeting (applies_to.student_ids). OR'd with the other
  // criteria by the portal matcher: a student sees the form if they're picked
  // here OR match a program/grade/tag.
  function toggleStudent(id: string) {
    const next = toggleIn(studentIds, id);
    const base: FormAppliesTo = { ...(settings.applies_to ?? {}) };
    if (next.length) base.student_ids = next; else delete base.student_ids;
    onPatch({ applies_to: Object.keys(base).length === 0 ? null : base });
  }
  const stuById = new Map(studentOptions.map((s) => [s.id, s]));
  const stuMatches = stuSearch.trim()
    ? studentOptions.filter((s) => s.name.toLowerCase().includes(stuSearch.trim().toLowerCase())).slice(0, 20)
    : [];

  const nothingToTarget = progList.length === 0 && gradeList.length === 0 && tagList.length === 0 && studentOptions.length === 0;

  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-800"><Users className="h-3.5 w-3.5" /> Who sees this form</div>
      {nothingToTarget ? (
        <p className="text-[11px] text-slate-400">No students, programs, grades, or tags found on your records yet — this form shows to everyone.</p>
      ) : (
        <>
          <label className="mb-1.5 flex items-center gap-2 text-sm text-slate-700">
            <input type="radio" checked={!hasRule}
              onChange={() => onPatch({ applies_to: excl.length ? { tag_exclude: excl } : null })}
              className="h-4 w-4 text-emerald-600" />
            Everyone
          </label>
          <label className="mb-2 flex items-center gap-2 text-sm text-slate-700">
            <input type="radio" checked={hasRule}
              onChange={() => { if (!hasRule) { const first = showProgram && progList.length ? [progList[0]] : []; const t = !first.length && tagList.length ? [tagList[0]] : []; apply({ programs: first, grades: [], tags: t }); } }}
              className="h-4 w-4 text-emerald-600" />
            Only specific students, programs, grades, or tags
          </label>
          {hasRule ? (
            <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-2.5">
              {studentOptions.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Specific students</div>
                  {studentIds.map((id) => (
                    <div key={id} className="flex items-center justify-between gap-2 text-xs text-slate-800">
                      <span className="truncate">{stuById.get(id)?.name ?? '(student no longer on roster)'}
                        {stuById.get(id)?.program ? <span className="text-slate-400"> · {stuById.get(id)!.program}</span> : null}</span>
                      <button onClick={() => toggleStudent(id)} className="shrink-0 text-slate-300 hover:text-rose-500" title="Remove"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <div className="mt-1 flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1">
                    <Search className="h-3 w-3 shrink-0 text-slate-400" />
                    <input value={stuSearch} onChange={(e) => setStuSearch(e.target.value)} placeholder="Add a student by name…"
                      className="w-full bg-transparent text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none" />
                  </div>
                  {stuMatches.length > 0 ? (
                    <div className="mt-1 max-h-36 overflow-y-auto rounded-md border border-slate-200 bg-white">
                      {stuMatches.map((s) => (
                        <button key={s.id} onClick={() => { toggleStudent(s.id); setStuSearch(''); }}
                          className="flex w-full items-center justify-between px-2 py-1 text-left text-xs text-slate-700 hover:bg-emerald-50">
                          <span className="truncate">{s.name}{s.program ? <span className="text-slate-400"> · {s.program}</span> : null}</span>
                          <span className="shrink-0 text-emerald-600">{studentIds.includes(s.id) ? '✓' : '+'}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {showProgram ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">By program</div>
                  {progList.map((p) => (
                    <label key={p} className="flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" checked={programs.includes(p)} onChange={() => apply({ programs: toggleIn(programs, p) })} className={cb} />{p}
                    </label>
                  ))}
                </div>
              ) : null}
              {showGrade ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">By grade</div>
                  {gradeList.map((g) => (
                    <label key={g} className="flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" checked={grades.includes(g)} onChange={() => apply({ grades: toggleIn(grades, g) })} className={cb} />{g}
                    </label>
                  ))}
                </div>
              ) : null}
              {showTag ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">By tag</div>
                  {tagList.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-xs text-slate-700">
                      <input type="checkbox" checked={tags.includes(t)} onChange={() => apply({ tags: toggleIn(tags, t) })} className={cb} />{t}
                    </label>
                  ))}
                </div>
              ) : null}
              {!settings.per_student && (programOptions.length > 0 || gradeOptions.length > 0) ? (
                <p className="text-[11px] text-amber-600">Turn on “One form per student” above to target by program or grade.</p>
              ) : null}
              <p className="text-[11px] text-slate-400">A family only sees the form for the children who match. Pick at least one — otherwise it shows to everyone.</p>
            </div>
          ) : null}
          {tagList.length > 0 || excl.length > 0 ? (
            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50/50 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700">Hide from families with these tags</div>
              <p className="mb-1.5 text-[11px] text-slate-500">
                Tagged families never see this form — even with &ldquo;Everyone&rdquo; selected. Typical use:
                hide the enrollment agreement from already-enrolled families. Sending it directly to a
                family still overrides this.
              </p>
              {Array.from(new Set([...tagOptions, ...excl])).map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs text-slate-700">
                  <input type="checkbox" checked={excl.includes(t)}
                    onChange={() => {
                      const next = toggleIn(excl, t);
                      const base: FormAppliesTo = { ...(settings.applies_to ?? {}) };
                      if (next.length) base.tag_exclude = next; else delete base.tag_exclude;
                      onPatch({ applies_to: Object.keys(base).length === 0 ? null : base });
                    }}
                    className="h-3.5 w-3.5 rounded border-rose-300 text-rose-600" />{t}
                </label>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function FormSettingsPanel({ settings, onPatch, programOptions, gradeOptions, tagOptions, studentOptions }: {
  settings: FormSettings; onPatch: (patch: Partial<FormSettings>) => void;
  programOptions: string[]; gradeOptions: string[]; tagOptions: string[];
  studentOptions: Array<{ id: string; name: string; program: string | null }>;
}) {
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
      <WhoSeesEditor settings={settings} onPatch={onPatch} programOptions={programOptions} gradeOptions={gradeOptions} tagOptions={tagOptions} studentOptions={studentOptions} />
    </div>
  );
}
