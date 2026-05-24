'use client';

// Structured editor for a single form definition. Operators edit:
//   - Metadata (display name, description, category, toggles)
//   - Per-field properties (label, help, required, options, prices)
//   - Add/remove/reorder fields
//
// Saves the entire field_schema in one PATCH. Server validates the
// shape so a bad edit doesn't brick the form.
//
// What we DON'T support (yet):
//   - Changing a field's `type` after creation (would orphan responses)
//   - Editing payment_config (uses a separate flow)
//   - Editing prefill sources (operator chooses from a fixed list when
//     adding a new field; can't tweak an existing one's source)

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  GripVertical, Trash2, ChevronDown, ChevronRight, Plus,
  AlertCircle, Save, CheckCircle2,
} from 'lucide-react';

type FieldType =
  | 'header' | 'paragraph' | 'section'
  | 'text' | 'email' | 'tel' | 'url' | 'textarea' | 'number' | 'date'
  | 'select' | 'radio' | 'checkbox' | 'multi_checkbox'
  | 'file_upload'
  | 'signature_drawn' | 'signature_typed'
  | 'pricing_select' | 'multi_pricing' | 'quantity_pricing' | 'tuition_calculator';

interface Option { value: string; label: string; amount_cents?: number }
interface FieldBlock {
  type: FieldType;
  key?: string;
  label?: string;
  text?: string;
  help?: string;
  required?: boolean;
  options?: Option[];
  emphasis?: 'normal' | 'note' | 'warning';
  description?: string;
  placeholder?: string;
  max_length?: number;
  rows?: number;
  // pricing-specific
  show_price_in_label?: boolean;
  unit_label?: string;
  unit_amount_cents?: number;
  min?: number | string;
  max?: number | string;
  // signature
  acknowledgment?: string;
  // file
  accept?: string;
  multiple?: boolean;
  max_size_mb?: number;
  // tuition calc
  include_plan_picker?: boolean;
  academic_year?: string;
  // free-form for any field type we don't have explicit UI for
  [k: string]: unknown;
}

interface InitialState {
  display_name: string;
  description: string | null;
  category: string | null;
  per_student: boolean;
  is_active: boolean;
  allow_addendum: boolean;
  needs_review: boolean;
  resubmission_allowed: boolean;
  one_submission_per_year: boolean;
  field_schema: unknown[];
}

const FIELD_TYPE_OPTIONS: Array<{ value: FieldType; label: string; group: string }> = [
  { value: 'header',         label: 'Header (large title)',  group: 'Layout' },
  { value: 'paragraph',      label: 'Paragraph (info text)', group: 'Layout' },
  { value: 'section',        label: 'Section divider',       group: 'Layout' },
  { value: 'text',           label: 'Text',                  group: 'Input' },
  { value: 'textarea',       label: 'Long text',             group: 'Input' },
  { value: 'email',          label: 'Email',                 group: 'Input' },
  { value: 'tel',            label: 'Phone',                 group: 'Input' },
  { value: 'number',         label: 'Number',                group: 'Input' },
  { value: 'date',           label: 'Date',                  group: 'Input' },
  { value: 'url',            label: 'URL',                   group: 'Input' },
  { value: 'select',         label: 'Dropdown (single)',     group: 'Choice' },
  { value: 'radio',          label: 'Radio (single)',        group: 'Choice' },
  { value: 'checkbox',       label: 'Checkbox (single)',     group: 'Choice' },
  { value: 'multi_checkbox', label: 'Checkboxes (multi)',    group: 'Choice' },
  { value: 'file_upload',    label: 'File upload',           group: 'Input' },
  { value: 'signature_drawn',label: 'Signature (drawn)',     group: 'Signature' },
  { value: 'signature_typed',label: 'Signature (typed name)',group: 'Signature' },
  { value: 'pricing_select', label: 'Priced choice (single)',group: 'Pricing' },
  { value: 'multi_pricing',  label: 'Priced choices (multi)',group: 'Pricing' },
  { value: 'quantity_pricing',label: 'Priced quantity',      group: 'Pricing' },
];

export function FormEditor({
  schoolId, formId, slug, initial,
}: {
  schoolId: string;
  formId: string;
  slug: string;
  initial: InitialState;
}) {
  const router = useRouter();

  const [meta, setMeta] = useState({
    display_name: initial.display_name,
    description: initial.description ?? '',
    category: initial.category ?? '',
    per_student: initial.per_student,
    is_active: initial.is_active,
    allow_addendum: initial.allow_addendum,
    needs_review: initial.needs_review,
    resubmission_allowed: initial.resubmission_allowed,
    one_submission_per_year: initial.one_submission_per_year,
  });

  const [fields, setFields] = useState<FieldBlock[]>(
    (initial.field_schema as FieldBlock[]).map((b) => ({ ...b })),
  );

  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fieldCount = useMemo(() => fields.filter((f) => 'key' in f).length, [fields]);

  function patchMeta<K extends keyof typeof meta>(k: K, v: typeof meta[K]) {
    setMeta({ ...meta, [k]: v });
  }
  function patchField(i: number, patch: Partial<FieldBlock>) {
    const next = [...fields];
    next[i] = { ...next[i], ...patch };
    setFields(next);
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
    setOpenIdx(j);
  }
  function deleteField(i: number) {
    if (!confirm('Remove this field? Any existing responses for it will stay in the DB but won\'t be visible on new submissions.')) return;
    const next = fields.slice(0, i).concat(fields.slice(i + 1));
    setFields(next);
    if (openIdx === i) setOpenIdx(null);
  }
  function addField(type: FieldType) {
    const seed = makeNewField(type);
    setFields([...fields, seed]);
    setOpenIdx(fields.length);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta, field_schema: fields }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      setSavedAt(new Date());
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ── Metadata ──────────────────────────────────────────── */}
      <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Form details</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Display name (shown to parents)">
            <input
              type="text"
              value={meta.display_name}
              onChange={(e) => patchMeta('display_name', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Category">
            <input
              type="text"
              value={meta.category}
              onChange={(e) => patchMeta('category', e.target.value)}
              placeholder="enrollment, medical, permission…"
              className={inputCls}
            />
          </Field>
          <Field label="Description (1–2 sentences shown above the form)" className="sm:col-span-2">
            <textarea
              value={meta.description}
              onChange={(e) => patchMeta('description', e.target.value)}
              rows={2}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 pt-2 border-t border-zinc-100">
          <ToggleField label="Active" checked={meta.is_active}
            onChange={(v) => patchMeta('is_active', v)}
            hint="When off, parents can't fill the form." />
          <ToggleField label="Per-student" checked={meta.per_student}
            onChange={(v) => patchMeta('per_student', v)}
            hint="Parent picks which child this is for." />
          <ToggleField label="Allow addendum" checked={meta.allow_addendum}
            onChange={(v) => patchMeta('allow_addendum', v)}
            hint="Parents can submit partial updates." />
          <ToggleField label="Resubmission allowed" checked={meta.resubmission_allowed}
            onChange={(v) => patchMeta('resubmission_allowed', v)}
            hint="Parent can re-submit a full new version." />
          <ToggleField label="One per year" checked={meta.one_submission_per_year}
            onChange={(v) => patchMeta('one_submission_per_year', v)}
            hint="Locks the form after the first submission this academic year." />
          <ToggleField label="Needs review" checked={meta.needs_review}
            onChange={(v) => patchMeta('needs_review', v)}
            hint="Surfaces this form in the admin review queue." />
        </div>
      </section>

      {/* ── Fields ────────────────────────────────────────────── */}
      <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-900">
            Fields ({fields.length} blocks · {fieldCount} answerable)
          </h2>
          <div className="text-[11px] text-zinc-500">Click a field to expand and edit.</div>
        </div>

        <ul className="space-y-1.5">
          {fields.map((f, i) => (
            <FieldCard
              key={i}
              i={i}
              total={fields.length}
              field={f}
              open={openIdx === i}
              onToggle={() => setOpenIdx(openIdx === i ? null : i)}
              onPatch={(patch) => patchField(i, patch)}
              onMoveUp={() => moveField(i, -1)}
              onMoveDown={() => moveField(i, 1)}
              onDelete={() => deleteField(i)}
            />
          ))}
        </ul>

        <AddFieldControl onAdd={addField} />
      </section>

      {/* ── Save bar ──────────────────────────────────────────── */}
      <div className="sticky bottom-4 z-10 rounded-lg border-2 border-emerald-300 bg-white shadow-lg p-3 flex items-center justify-between gap-3">
        <div className="text-xs text-zinc-600">
          <span className="font-mono">{slug}</span>
          {savedAt ? (
            <span className="ml-3 inline-flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Saved {savedAt.toLocaleTimeString()}
            </span>
          ) : null}
          {err ? (
            <span className="ml-3 inline-flex items-center gap-1 text-rose-700">
              <AlertCircle className="h-3 w-3" /> {err}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving…' : 'Save form'}
        </button>
      </div>
    </div>
  );
}

// ─── Per-field card ──────────────────────────────────────────────

function FieldCard({
  i, total, field, open, onToggle, onPatch, onMoveUp, onMoveDown, onDelete,
}: {
  i: number;
  total: number;
  field: FieldBlock;
  open: boolean;
  onToggle: () => void;
  onPatch: (p: Partial<FieldBlock>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const isDisplayOnly = field.type === 'header' || field.type === 'paragraph' || field.type === 'section';
  const summary = isDisplayOnly
    ? (field.text || field.label || `(${field.type})`)
    : (field.label || `(no label)`);

  return (
    <li className="rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex flex-col -my-0.5">
          <button type="button" onClick={onMoveUp} disabled={i === 0}
            className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed">▲</button>
          <button type="button" onClick={onMoveDown} disabled={i === total - 1}
            className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed">▼</button>
        </div>
        <GripVertical className="h-3.5 w-3.5 text-zinc-300" />
        <button type="button" onClick={onToggle} className="flex-1 min-w-0 text-left flex items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
          <span className="text-[10px] uppercase tracking-wide font-mono text-zinc-500 w-24 shrink-0">{field.type}</span>
          <span className="text-sm text-zinc-900 truncate">{summary}</span>
          {field.required ? <span className="text-rose-500 text-xs">*</span> : null}
          {field.key ? (
            <span className="text-[10px] text-zinc-400 font-mono">{field.key}</span>
          ) : null}
        </button>
        <button type="button" onClick={onDelete}
          className="rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-700">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open ? (
        <div className="border-t border-zinc-100 bg-zinc-50/30 p-3 space-y-3">
          <FieldBody field={field} onPatch={onPatch} />
        </div>
      ) : null}
    </li>
  );
}

// ─── Per-type body editor ────────────────────────────────────────

function FieldBody({
  field, onPatch,
}: {
  field: FieldBlock;
  onPatch: (p: Partial<FieldBlock>) => void;
}) {
  const t = field.type;

  // Display-only types
  if (t === 'header') {
    return (
      <Field label="Header text">
        <input type="text" value={field.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} className={inputCls} />
      </Field>
    );
  }
  if (t === 'paragraph') {
    return (
      <>
        <Field label="Paragraph text">
          <textarea value={field.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} rows={4} className={inputCls} />
        </Field>
        <Field label="Emphasis">
          <select value={field.emphasis ?? 'normal'} onChange={(e) => onPatch({ emphasis: e.target.value as FieldBlock['emphasis'] })} className={inputCls}>
            <option value="normal">Normal</option>
            <option value="note">Note (gray box)</option>
            <option value="warning">Warning (amber box)</option>
          </select>
        </Field>
      </>
    );
  }
  if (t === 'section') {
    return (
      <>
        <Field label="Section label"><input type="text" value={field.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} className={inputCls} /></Field>
        <Field label="Description (small text under label)">
          <input type="text" value={field.description ?? ''} onChange={(e) => onPatch({ description: e.target.value })} className={inputCls} />
        </Field>
      </>
    );
  }

  // All keyed types share label/key/required/help
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Label (shown to parent)">
          <input type="text" value={field.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Field key (internal, no spaces)">
          <input type="text" value={field.key ?? ''} onChange={(e) => onPatch({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} className={inputCls + ' font-mono'} />
        </Field>
        <Field label="Help text (small hint under label, optional)" className="sm:col-span-2">
          <input type="text" value={field.help ?? ''} onChange={(e) => onPatch({ help: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <ToggleField label="Required" checked={!!field.required} onChange={(v) => onPatch({ required: v })} />

      {/* Choice fields */}
      {(t === 'select' || t === 'radio' || t === 'multi_checkbox') ? (
        <OptionsEditor
          options={field.options ?? []}
          onChange={(opts) => onPatch({ options: opts })}
          pricing={false}
        />
      ) : null}

      {/* Priced choice fields */}
      {(t === 'pricing_select' || t === 'multi_pricing') ? (
        <>
          <OptionsEditor
            options={field.options ?? []}
            onChange={(opts) => onPatch({ options: opts })}
            pricing
          />
          {t === 'pricing_select' ? (
            <ToggleField label="Show price in label (e.g. &quot;$25 — Pizza&quot;)"
              checked={!!field.show_price_in_label}
              onChange={(v) => onPatch({ show_price_in_label: v })} />
          ) : null}
        </>
      ) : null}

      {t === 'quantity_pricing' ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Unit label (e.g. 'ticket')">
            <input type="text" value={field.unit_label ?? ''} onChange={(e) => onPatch({ unit_label: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Unit amount (cents)">
            <input type="number" value={field.unit_amount_cents ?? 0} onChange={(e) => onPatch({ unit_amount_cents: parseInt(e.target.value || '0', 10) })} className={inputCls} />
          </Field>
          <Field label="Max">
            <input type="number" value={Number(field.max ?? 99)} onChange={(e) => onPatch({ max: parseInt(e.target.value || '99', 10) })} className={inputCls} />
          </Field>
        </div>
      ) : null}

      {t === 'signature_typed' ? (
        <Field label="Acknowledgment text (shown above the input)">
          <textarea value={field.acknowledgment ?? ''} onChange={(e) => onPatch({ acknowledgment: e.target.value })} rows={2} className={inputCls} />
        </Field>
      ) : null}

      {t === 'file_upload' ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Accepted extensions">
            <input type="text" value={field.accept ?? '.pdf,.jpg,.jpeg,.png'} onChange={(e) => onPatch({ accept: e.target.value })} className={inputCls + ' font-mono text-xs'} />
          </Field>
          <ToggleField label="Allow multiple" checked={!!field.multiple} onChange={(v) => onPatch({ multiple: v })} />
          <Field label="Max size (MB)">
            <input type="number" value={field.max_size_mb ?? 10} onChange={(e) => onPatch({ max_size_mb: parseInt(e.target.value || '10', 10) })} className={inputCls} />
          </Field>
        </div>
      ) : null}

      {(t === 'text' || t === 'email' || t === 'tel' || t === 'url' || t === 'textarea' || t === 'number' || t === 'date') ? (
        <Field label="Placeholder (optional)">
          <input type="text" value={field.placeholder ?? ''} onChange={(e) => onPatch({ placeholder: e.target.value })} className={inputCls} />
        </Field>
      ) : null}
    </>
  );
}

// ─── Options editor (dropdowns / radios / pricing) ────────────────

function OptionsEditor({
  options, onChange, pricing,
}: {
  options: Option[];
  onChange: (opts: Option[]) => void;
  pricing: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-600 mb-1.5">
        Options ({options.length})
      </div>
      <ul className="space-y-1">
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              type="text"
              value={o.label}
              onChange={(e) => onChange(options.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
              placeholder="Label (shown to parent)"
              className={inputCls + ' flex-1'}
            />
            <input
              type="text"
              value={o.value}
              onChange={(e) => onChange(options.map((x, j) => j === i ? { ...x, value: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') } : x))}
              placeholder="value"
              className={inputCls + ' w-32 font-mono text-xs'}
            />
            {pricing ? (
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-zinc-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={(o.amount_cents ?? 0) / 100}
                  onChange={(e) => onChange(options.map((x, j) => j === i ? { ...x, amount_cents: Math.round((parseFloat(e.target.value) || 0) * 100) } : x))}
                  className={inputCls + ' w-24 pl-5'}
                />
              </div>
            ) : null}
            <button type="button"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              className="rounded p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-700">
              <Trash2 className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...options, { value: `option_${options.length + 1}`, label: '', ...(pricing ? { amount_cents: 0 } : {}) }])}
        className="mt-2 inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50"
      >
        <Plus className="h-3 w-3" /> Add option
      </button>
    </div>
  );
}

// ─── Add-field control ───────────────────────────────────────────

function AddFieldControl({ onAdd }: { onAdd: (t: FieldType) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-emerald-300 bg-white px-3 py-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">
        <Plus className="h-4 w-4" /> Add a field
      </button>
    );
  }
  const groups = [...new Set(FIELD_TYPE_OPTIONS.map((o) => o.group))];
  return (
    <div className="rounded-md border-2 border-emerald-300 bg-white p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Add a field</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-700">cancel</button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {groups.map((g) => (
          <div key={g}>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 font-semibold mb-1">{g}</div>
            <div className="flex flex-col gap-1">
              {FIELD_TYPE_OPTIONS.filter((o) => o.group === g).map((o) => (
                <button key={o.value} type="button"
                  onClick={() => { onAdd(o.value); setOpen(false); }}
                  className="text-left rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-700 hover:border-emerald-400 hover:bg-emerald-50">
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function makeNewField(type: FieldType): FieldBlock {
  const base: FieldBlock = { type };
  if (type === 'header' || type === 'paragraph') {
    base.text = '';
    return base;
  }
  if (type === 'section') {
    base.label = 'New section';
    return base;
  }
  base.key = `field_${Math.random().toString(36).slice(2, 8)}`;
  base.label = '';
  base.required = false;
  if (type === 'select' || type === 'radio' || type === 'multi_checkbox') {
    base.options = [{ value: 'option_1', label: 'Option 1' }];
  }
  if (type === 'pricing_select' || type === 'multi_pricing') {
    base.options = [{ value: 'option_1', label: 'Option 1', amount_cents: 0 }];
  }
  if (type === 'quantity_pricing') {
    base.unit_label = 'item';
    base.unit_amount_cents = 0;
    base.min = 0;
    base.max = 10;
  }
  if (type === 'file_upload') {
    base.accept = '.pdf,.jpg,.jpeg,.png';
    base.multiple = false;
    base.max_size_mb = 10;
  }
  return base;
}

// ─── Small UI helpers ────────────────────────────────────────────

const inputCls =
  'block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200';

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function ToggleField({
  label, checked, onChange, hint,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
      <span>
        <span className="text-zinc-800">{label}</span>
        {hint ? <span className="block text-[10px] text-zinc-500">{hint}</span> : null}
      </span>
    </label>
  );
}
