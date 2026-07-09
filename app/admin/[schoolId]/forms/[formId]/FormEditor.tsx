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
  AlertCircle, Save, CheckCircle2, Search,
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
  // Lock a (usually prefilled) field so parents see the value but can't
  // edit it. Honored by the portal renderer, which locks `readOnly: true`
  // blocks (the value still submits).
  readOnly?: boolean;
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

// Per-student visibility rule. Mirrors lib/forms/applies-to.ts in the
// parent portal (kept as a local copy — the two repos don't share code).
// This editor only manages `program_match`; any other criteria a form
// already carries are preserved untouched on save.
interface FormAppliesTo {
  program_match?: string[];
  tag_match?: string[];
  tuition_grid_match?: string[];
  metadata_match?: Record<string, string[]>;
  addon_keys?: string[];
  student_ids?: string[];
  // Exclusion: families carrying any of these tags never see the form,
  // regardless of the inclusion rules above (office pushes still override).
  tag_exclude?: string[];
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
  // Migration 040 — test-mode + post-submit behavior
  confirmation_message?: string | null;
  confirmation_redirect_url?: string | null;
  notify_emails?: string[];
  // Migration 042 — webhook fan-out
  webhook_urls?: string[];
  // Per-student form visibility rule
  applies_to?: FormAppliesTo | null;
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
  schoolId, formId, slug, initial, programOptions = [], gradeOptions = [], tagOptions = [], studentOptions = [],
}: {
  schoolId: string;
  formId: string;
  slug: string;
  initial: InitialState;
  // Distinct GHL contact tags synced for this school, for the
  // "who sees this form" tag checklist. Backed by applies_to.tag_match.
  tagOptions?: string[];
  // Distinct program values found on this school's student records, used
  // to populate the "Who sees this form" checklist. Empty → the school
  // has no program data yet and program targeting is hidden.
  programOptions?: string[];
  // Distinct grade_level values on the roster (e.g. "kindergarten").
  // Lets the school target a form by grade even when that grade is folded
  // into a broader program (e.g. MCH's kindergartners are stored under the
  // Primary program with grade_level="kindergarten"). Backed by
  // applies_to.metadata_match.grade_level — sync-safe (additive merge).
  gradeOptions?: string[];
  // Active students for the "Specific students" picker (applies_to.student_ids).
  studentOptions?: Array<{ id: string; name: string; program: string | null }>;
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
    confirmation_message: initial.confirmation_message ?? '',
    confirmation_redirect_url: initial.confirmation_redirect_url ?? '',
    notify_emails_raw: (initial.notify_emails ?? []).join(', '),
    webhook_urls_raw: (initial.webhook_urls ?? []).join('\n'),
  });

  const [fields, setFields] = useState<FieldBlock[]>(
    (initial.field_schema as FieldBlock[]).map((b) => ({ ...b })),
  );

  // ── Who sees this form ─────────────────────────────────────────
  // This UI manages two dimensions: program_match (by program) and
  // metadata_match.grade_level (by grade). ANY other criteria on the
  // rule (a hand-picked student list, tuition-grid match, other
  // metadata_match keys like aftercare) are stashed and merged back in
  // untouched on save, so this screen can never clobber an advanced rule
  // set up out-of-band.
  const otherCriteria = useMemo<Omit<FormAppliesTo, 'program_match' | 'tag_match' | 'student_ids' | 'tag_exclude'>>(() => {
    const { program_match, tag_match, student_ids, tag_exclude, metadata_match, ...rest } = initial.applies_to ?? {};
    void program_match; void tag_match; void student_ids; void tag_exclude;
    // Preserve every metadata_match key EXCEPT grade_level, which this
    // screen owns. Keeps e.g. the DHS form's `aftercare` rule intact.
    const out: Omit<FormAppliesTo, 'program_match' | 'tag_match' | 'student_ids' | 'tag_exclude'> = { ...rest };
    if (metadata_match) {
      const { grade_level, ...mmRest } = metadata_match;
      void grade_level;
      if (Object.keys(mmRest).length) out.metadata_match = mmRest;
    }
    return out;
  }, [initial.applies_to]);
  const hasOtherCriteria = Object.keys(otherCriteria).length > 0;
  // Checklist = every program on the roster + any program the rule
  // already names (so a renamed/removed program stays visible & removable).
  const programChecklist = useMemo(() => {
    const stored = initial.applies_to?.program_match ?? [];
    return Array.from(new Set([...programOptions, ...stored]));
  }, [programOptions, initial.applies_to]);
  // Same for grades: roster grade_level values + any the rule already names.
  const gradeChecklist = useMemo(() => {
    const stored = initial.applies_to?.metadata_match?.grade_level ?? [];
    return Array.from(new Set([...gradeOptions, ...stored]));
  }, [gradeOptions, initial.applies_to]);
  // Tags: every synced GHL tag + any the rule already names.
  const tagChecklist = useMemo(() => {
    const stored = initial.applies_to?.tag_match ?? [];
    return Array.from(new Set([...tagOptions, ...stored]));
  }, [tagOptions, initial.applies_to]);
  const [selectedPrograms, setSelectedPrograms] = useState<string[]>(
    initial.applies_to?.program_match ?? [],
  );
  const [selectedGrades, setSelectedGrades] = useState<string[]>(
    initial.applies_to?.metadata_match?.grade_level ?? [],
  );
  const [selectedTags, setSelectedTags] = useState<string[]>(
    initial.applies_to?.tag_match ?? [],
  );
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(
    initial.applies_to?.student_ids ?? [],
  );
  // Exclusion tags — independent of the show-to radio: families carrying
  // any of these never see the form even when "everyone" is selected.
  const [excludedTags, setExcludedTags] = useState<string[]>(
    initial.applies_to?.tag_exclude ?? [],
  );
  const excludeChecklist = useMemo(() => {
    const stored = initial.applies_to?.tag_exclude ?? [];
    return Array.from(new Set([...tagOptions, ...stored]));
  }, [tagOptions, initial.applies_to]);
  const [studentSearch, setStudentSearch] = useState('');
  const restrictedInitially =
    (initial.applies_to?.program_match?.length ?? 0) > 0 ||
    (initial.applies_to?.metadata_match?.grade_level?.length ?? 0) > 0 ||
    (initial.applies_to?.tag_match?.length ?? 0) > 0 ||
    (initial.applies_to?.student_ids?.length ?? 0) > 0;
  const [audienceMode, setAudienceMode] = useState<'all' | 'restricted'>(
    restrictedInitially ? 'restricted' : 'all',
  );

  // Build the applies_to value to persist. Empty → null ("all students").
  // program_match and grade_level are OR'd by the matcher: a student sees
  // the form if they're in a selected program OR a selected grade.
  function buildAppliesTo(): FormAppliesTo | null {
    const base: FormAppliesTo = { ...otherCriteria };
    if (audienceMode === 'restricted') {
      if (selectedPrograms.length > 0) base.program_match = selectedPrograms;
      if (selectedTags.length > 0) base.tag_match = selectedTags;
      if (selectedStudentIds.length > 0) base.student_ids = selectedStudentIds;
      if (selectedGrades.length > 0) {
        base.metadata_match = { ...(base.metadata_match ?? {}), grade_level: selectedGrades };
      }
    }
    // Exclusion applies in BOTH modes — "everyone except…" is the whole point.
    if (excludedTags.length > 0) base.tag_exclude = excludedTags;
    return Object.keys(base).length ? base : null;
  }

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
      // Split notify_emails_raw (comma/newline/space separated) into a
      // clean array before sending — the API validates each entry too.
      const notifyEmails = meta.notify_emails_raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      // Webhook URLs are one per line. API will reject non-https schemes.
      const webhookUrls = meta.webhook_urls_raw
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const { notify_emails_raw, webhook_urls_raw, ...metaForApi } = meta;
      void notify_emails_raw; void webhook_urls_raw;
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meta: {
            ...metaForApi,
            notify_emails: notifyEmails,
            webhook_urls: webhookUrls,
            applies_to: buildAppliesTo(),
          },
          field_schema: fields,
        }),
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
          <ToggleField
            label={meta.is_active ? 'Published' : 'Draft'}
            checked={meta.is_active}
            onChange={(v) => patchMeta('is_active', v)}
            hint={meta.is_active
              ? 'Visible in the parent portal. Toggle off to unpublish (Draft) — parents won\'t see it.'
              : 'Hidden from the parent portal. Toggle on to publish.'}
          />
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

      {/* ── Who sees this form (applies_to.program_match) ──────── */}
      <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Who sees this form</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            By default every child in a family sees this form. Restrict it to specific
            programs and each family only sees it for the children enrolled in those
            programs — so a family with a Primary child and a Lower&nbsp;El child sees a
            Lower-El-only form just for the Lower&nbsp;El child. A child&rsquo;s program comes
            straight from their contact record.
          </p>
        </div>

        {(programChecklist.length === 0 && gradeChecklist.length === 0 && tagChecklist.length === 0) ? (
          <p className="text-[11px] text-zinc-500">
            No programs, grades, or tags were found on your records yet, so there&rsquo;s
            nothing to target by — this form shows to everyone.
          </p>
        ) : (
          <div className="space-y-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="audience" checked={audienceMode === 'all'}
                onChange={() => setAudienceMode('all')} className="mt-0.5 h-4 w-4" />
              <span>
                <span className="text-zinc-800">Everyone</span>
                <span className="block text-[10px] text-zinc-500">Every family (and every child) sees this form.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="audience" checked={audienceMode === 'restricted'}
                onChange={() => setAudienceMode('restricted')} className="mt-0.5 h-4 w-4" />
              <span>
                <span className="text-zinc-800">Only specific students, programs, grades, or tags</span>
                <span className="block text-[10px] text-zinc-500">Pick below — the form hides for anyone not matching.</span>
              </span>
            </label>

            {audienceMode === 'restricted' ? (
              <div className="ml-6 space-y-3">
                {meta.per_student && studentOptions.length > 0 ? (
                  <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Specific students</div>
                    {selectedStudentIds.map((id) => {
                      const s = studentOptions.find((x) => x.id === id);
                      return (
                        <div key={id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate text-zinc-800">{s?.name ?? '(no longer on roster)'}{s?.program ? <span className="text-zinc-400"> · {s.program}</span> : null}</span>
                          <button type="button" onClick={() => setSelectedStudentIds(selectedStudentIds.filter((x) => x !== id))}
                            className="shrink-0 text-xs text-zinc-400 hover:text-red-600">remove</button>
                        </div>
                      );
                    })}
                    <input
                      value={studentSearch}
                      onChange={(e) => setStudentSearch(e.target.value)}
                      placeholder="Add a student by name…"
                      className="block w-full rounded border border-zinc-300 px-2 py-1 text-sm"
                    />
                    {studentSearch.trim() ? (
                      <div className="max-h-36 overflow-y-auto rounded border border-zinc-200 bg-white">
                        {studentOptions
                          .filter((s) => s.name.toLowerCase().includes(studentSearch.trim().toLowerCase()))
                          .slice(0, 15)
                          .map((s) => (
                            <button key={s.id} type="button"
                              onClick={() => { if (!selectedStudentIds.includes(s.id)) setSelectedStudentIds([...selectedStudentIds, s.id]); setStudentSearch(''); }}
                              className="block w-full px-2 py-1 text-left text-sm text-zinc-700 hover:bg-emerald-50">
                              {s.name}{s.program ? <span className="text-zinc-400"> · {s.program}</span> : null}
                            </button>
                          ))}
                      </div>
                    ) : null}
                    <p className="text-[10px] text-zinc-500">The form shows ONLY for the students picked here (plus anyone matching a program/grade/tag below).</p>
                  </div>
                ) : null}

                {meta.per_student && programChecklist.length > 0 ? (
                  <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">By program</div>
                    {programChecklist.map((prog) => (
                      <label key={prog} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedPrograms.includes(prog)}
                          onChange={(e) => {
                            setSelectedPrograms(
                              e.target.checked
                                ? [...selectedPrograms, prog]
                                : selectedPrograms.filter((p) => p !== prog),
                            );
                          }}
                          className="h-4 w-4 rounded border-zinc-300"
                        />
                        <span className="text-zinc-800">{prog}</span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {meta.per_student && gradeChecklist.length > 0 ? (
                  <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">By grade</div>
                    {gradeChecklist.map((g) => (
                      <label key={g} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedGrades.includes(g)}
                          onChange={(e) => {
                            setSelectedGrades(
                              e.target.checked
                                ? [...selectedGrades, g]
                                : selectedGrades.filter((x) => x !== g),
                            );
                          }}
                          className="h-4 w-4 rounded border-zinc-300"
                        />
                        <span className="text-zinc-800 capitalize">{g}</span>
                      </label>
                    ))}
                  </div>
                ) : null}

                {tagChecklist.length > 0 ? (
                  <div className="rounded-md border border-zinc-200 bg-zinc-50/40 p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">By GHL tag</div>
                    <p className="text-[10px] text-zinc-500 -mt-1">
                      Tag the parent&rsquo;s contact in GHL; this form then shows only to families carrying a selected tag.
                      Works for family-level forms too.
                    </p>
                    <TagChecklist
                      options={tagChecklist}
                      selected={selectedTags}
                      onToggle={(tag) => setSelectedTags(
                        selectedTags.includes(tag)
                          ? selectedTags.filter((x) => x !== tag)
                          : [...selectedTags, tag],
                      )}
                      checkboxClass="h-4 w-4 rounded border-zinc-300"
                    />
                  </div>
                ) : null}

                {!meta.per_student ? (
                  <p className="text-[10px] text-zinc-500 italic">
                    Program and grade targeting need a per-student form; tag targeting works here either way.
                  </p>
                ) : null}

                {selectedPrograms.length === 0 && selectedGrades.length === 0 && selectedTags.length === 0 && selectedStudentIds.length === 0 ? (
                  <p className="text-[11px] text-amber-700">
                    Select at least one student, program, grade, or tag — otherwise this form shows to everyone.
                  </p>
                ) : (
                  <p className="text-[11px] text-zinc-500">
                    Visible only to: {[
                      ...selectedStudentIds.map((id) => studentOptions.find((s) => s.id === id)?.name ?? 'a removed student'),
                      ...selectedPrograms, ...selectedGrades, ...selectedTags,
                    ].join(', ')}.
                  </p>
                )}
              </div>
            ) : null}

            {/* Exclusion — independent of the show-to radio above. */}
            <div className="rounded-md border border-rose-200 bg-rose-50/40 p-3 space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                Hide from families with these tags
              </div>
              <p className="text-[10px] text-zinc-600 -mt-0.5">
                Families whose GHL contact carries a checked tag never see this form — even when
                &ldquo;everyone&rdquo; is selected above. Typical use: hide the enrollment agreement from
                already-enrolled families while new families still get it. Sending the form directly
                to a family (the Send button) still works and overrides this.
              </p>
              <TagChecklist
                options={excludeChecklist}
                selected={excludedTags}
                onToggle={(tag) => setExcludedTags(
                  excludedTags.includes(tag)
                    ? excludedTags.filter((x) => x !== tag)
                    : [...excludedTags, tag],
                )}
                checkboxClass="h-4 w-4 rounded border-rose-300"
              />
              {excludedTags.length > 0 ? (
                <p className="text-[11px] text-rose-700">
                  Hidden from families tagged: {excludedTags.join(', ')}.
                </p>
              ) : null}
            </div>

            {hasOtherCriteria ? (
              <p className="text-[11px] rounded-md bg-sky-50 border border-sky-200 px-2.5 py-2 text-sky-800">
                This form also has an advanced visibility rule (a specific student list or
                tuition-grid match) set up outside this screen. It&rsquo;s kept intact when you save.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* ── After-submit behavior (migration 040) ─────────────── */}
      <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">After a parent submits</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Configure what parents see and who gets notified. Test all of this with the <strong>Preview layout</strong> button (Test mode → Submit) before pushing to families.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Field label="Custom thank-you message (optional, plain text — line breaks preserved)">
            <textarea
              value={meta.confirmation_message}
              onChange={(e) => patchMeta('confirmation_message', e.target.value)}
              rows={3}
              placeholder='e.g. "Thanks for completing this form! Our office will review and reach out within 2 business days."'
              className={inputCls}
            />
          </Field>
          <Field label="Redirect URL after submission (optional, must start with https://)">
            <input
              type="url"
              value={meta.confirmation_redirect_url}
              onChange={(e) => patchMeta('confirmation_redirect_url', e.target.value)}
              placeholder="https://your-school.com/thanks"
              className={inputCls}
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              If set, parents land here after their thank-you message. Useful for sending them to your school&rsquo;s own &ldquo;next steps&rdquo; page.
            </p>
          </Field>
          <Field label="Notify these office emails when a submission arrives (comma-separated)">
            <input
              type="text"
              value={meta.notify_emails_raw}
              onChange={(e) => patchMeta('notify_emails_raw', e.target.value)}
              placeholder="office@yourschool.com, admin@yourschool.com"
              className={inputCls}
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              These addresses get an email with the new submission summary. <strong>Test submissions never trigger real notifications</strong> — the dry-run report shows who would&rsquo;ve been emailed.
            </p>
          </Field>
          <Field label="Webhook URLs / automation triggers (one per line, https only)">
            <textarea
              value={meta.webhook_urls_raw}
              onChange={(e) => patchMeta('webhook_urls_raw', e.target.value)}
              rows={3}
              placeholder={'https://hooks.zapier.com/...\nhttps://services.leadconnectorhq.com/hooks/...\nhttps://your-backend.com/forms/webhook'}
              className={inputCls + ' font-mono text-xs'}
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              On every real submission, a JSON POST is fan-out to every URL with the form id, submission id, family info, and answers.
              Drop in Zapier / Make / GHL inbound webhooks / your own backend. Fire-and-forget with a 5s timeout per URL — a slow or
              failing webhook won&rsquo;t block the submission. Non-https URLs are rejected.
            </p>
          </Field>
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        <ToggleField label="Required" checked={!!field.required} onChange={(v) => onPatch({ required: v })} />
        <ToggleField label="Locked (read-only)" checked={!!field.readOnly} onChange={(v) => onPatch({ readOnly: v })}
          hint="Parents see the value but can't change it — use it for info prefilled from the contact record (name, address, program)." />
      </div>

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

// Tag checkbox list with a combined filter / add-new input. Every tag in the
// GHL location is listed; typing narrows the list, and a tag GHL doesn't know
// yet can still be added (GHL auto-creates a tag the first time it's applied,
// so targeting can be configured before anyone is tagged). Selected values
// always render even when the filter would hide them, so nothing checked can
// become un-uncheckable.
function TagChecklist({ options, selected, onToggle, checkboxClass }: {
  options: string[]; selected: string[]; onToggle: (tag: string) => void; checkboxClass: string;
}) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const all = Array.from(new Set([...options, ...selected]));
  const shown = q ? all.filter((t) => t.toLowerCase().includes(q) || selected.includes(t)) : all;
  const canAdd = q.length > 0 && !all.some((t) => t.toLowerCase() === q);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 rounded border border-zinc-300 bg-white px-2 py-1">
        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tags, or type a new tag…"
          className="w-full bg-transparent text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none" />
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {shown.map((tag) => (
          <label key={tag} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(tag)} onChange={() => onToggle(tag)}
              className={checkboxClass} />
            <span className="text-zinc-800">{tag}</span>
          </label>
        ))}
      </div>
      {canAdd ? (
        <button type="button" onClick={() => { onToggle(filter.trim()); setFilter(''); }}
          className="text-[11px] font-medium text-emerald-700 hover:text-emerald-900">
          + Add &ldquo;{filter.trim()}&rdquo;
        </button>
      ) : null}
    </div>
  );
}
