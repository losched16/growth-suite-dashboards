'use client';

// Interactive form for test mode. Re-implements the common field
// types from FormPreviewRenderer but with REAL inputs (not disabled).
// Submits multipart/form-data to the test-submit endpoint which
// persists with is_test=true and redirects to the result page where
// the staff member sees the thank-you experience + dry-run report.
//
// Intentionally simpler than the parent-portal's FormRenderer — this
// is a TEST sandbox. We don't enforce all validation rules; the goal
// is to let staff fire a submission with reasonable values and see
// the post-submit experience.

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';

type Block = Record<string, unknown>;
type VisibleWhen = { field?: string; equals?: string[] } | null | undefined;

// Mirror of the parent-portal's conditional-visibility semantics
// (lib/forms/prefill.ts). Kept in sync so the staff Test-mode preview
// hides/shows exactly what a real parent sees on the live form.
//
// Field-level: a block with no `visible_when` is always shown; otherwise
// it shows only when the referenced field's CURRENT value is one of
// `equals` — an empty/unselected reference field means HIDDEN.
function isBlockVisible(vw: VisibleWhen, values: Record<string, string>): boolean {
  if (!vw || !vw.field) return true;
  const cur = values[vw.field];
  const curStr = cur == null ? '' : String(cur);
  return (vw.equals ?? []).map(String).includes(curStr);
}

// Option-level: like the above, EXCEPT an empty/unselected reference field
// means SHOW the option (we don't filter until the parent has picked the
// thing the option depends on). Matches FormRenderer's PricingSelect filter.
function isOptionVisible(vw: VisibleWhen, values: Record<string, string>): boolean {
  if (!vw || !vw.field) return true;
  const v = values[vw.field];
  if (v == null || v === '') return true;
  return (vw.equals ?? []).map(String).includes(String(v));
}

export function TestSubmitForm({
  schoolId,
  formId,
  schema,
  perStudent,
  hasPayment,
  returnTo,
}: {
  schoolId: string;
  formId: string;
  schema: unknown[];
  perStudent: boolean;
  hasPayment: boolean;
  returnTo: string;
}) {
  const router = useRouter();
  const blocks = Array.isArray(schema) ? (schema as Block[]) : [];
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Reactive snapshot of current field values, recomputed from the form's
  // own FormData on every change. Drives conditional visibility so the
  // preview behaves like the live parent form (hides extended day for
  // half-day, drops the paid-lunch option for toddler/primary, etc.).
  const [responses, setResponses] = useState<Record<string, string>>({});

  function refreshResponses(form: HTMLFormElement) {
    const fd = new FormData(form);
    const next: Record<string, string> = {};
    for (const [k, v] of fd.entries()) next[k] = typeof v === 'string' ? v : '';
    setResponses(next);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const fd = new FormData(e.currentTarget);
      fd.set('return_to', returnTo);
      fd.set('form_definition_id', formId);
      const r = await fetch(
        `/api/admin/schools/${schoolId}/forms/${formId}/test-submit`,
        { method: 'POST', body: fd },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setSubmitting(false);
        return;
      }
      // The API returns { id, redirect_to } — navigate to the result page
      // inside the iframe so the staff member sees the post-submit experience.
      router.push(j.redirect_to as string);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setSubmitting(false);
    }
  }

  if (blocks.length === 0) {
    return (
      <div className="rounded-md border-2 border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">
        This form has no fields yet. Use the editor to add some.
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      onChange={(e) => refreshResponses(e.currentTarget)}
      className="space-y-5"
    >
      {perStudent ? (
        <input type="hidden" name="student_id" value="__test__" />
      ) : null}
      {blocks.map((block, i) =>
        isBlockVisible(block.visible_when as VisibleWhen, responses) ? (
          <Block key={i} block={block} responses={responses} />
        ) : null,
      )}

      {err ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>Test submission failed:</strong> {err}
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-3 border-t border-zinc-200 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {hasPayment ? 'Continue (test submit)' : 'Submit test'}
        </button>
        <span className="text-xs text-zinc-500">
          Marks the row <code>is_test=true</code>. Real notifications, GHL writebacks, and Stripe charges are suppressed.
        </span>
      </div>
    </form>
  );
}

// ─── Field renderers ───────────────────────────────────────────────

function Block({ block, responses }: { block: Block; responses: Record<string, string> }) {
  const type = String(block.type ?? '');
  const key = String(block.key ?? '');

  switch (type) {
    case 'header':
      return <h2 className="text-lg font-semibold text-zinc-900 border-b border-zinc-100 pb-2">{String(block.text ?? '')}</h2>;
    case 'paragraph':
      return (
        <p className={
          block.emphasis === 'warning' ? 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900' :
          block.emphasis === 'note'    ? 'rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700' :
                                         'text-sm text-zinc-700 whitespace-pre-wrap'
        }>{String(block.text ?? '')}</p>
      );
    case 'section':
      return (
        <div className="mt-4 rounded-md bg-zinc-50 border-l-4 border-emerald-500 px-3 py-2">
          <h3 className="text-base font-semibold text-zinc-900">{String(block.label ?? '')}</h3>
          {block.description ? <p className="mt-0.5 text-xs text-zinc-600">{String(block.description)}</p> : null}
        </div>
      );

    case 'text':
    case 'email':
    case 'tel':
    case 'url':
      return (
        <Shell block={block}>
          <input
            type={type === 'tel' ? 'tel' : type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
            name={key}
            placeholder={String(block.placeholder ?? '')}
            className={inputCls}
          />
        </Shell>
      );
    case 'textarea':
      return (
        <Shell block={block}>
          <textarea name={key} rows={Number(block.rows ?? 3)} placeholder={String(block.placeholder ?? '')} className={inputCls} />
        </Shell>
      );
    case 'number':
      return <Shell block={block}><input type="number" name={key} placeholder={String(block.placeholder ?? '')} className={inputCls} /></Shell>;
    case 'date':
      return <Shell block={block}><input type="date" name={key} className={inputCls} /></Shell>;

    case 'select': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <Shell block={block}>
          <select name={key} className={inputCls}>
            <option value="">— select —</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Shell>
      );
    }
    case 'radio': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <Shell block={block}>
          <div className="mt-1 space-y-1">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="radio" name={key} value={o.value} className="h-4 w-4 text-emerald-600" />
                {o.label}
              </label>
            ))}
          </div>
        </Shell>
      );
    }
    case 'checkbox':
      return (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name={key} value="1" className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
          <span className="text-zinc-800">
            {String(block.label ?? '')} {block.required ? <span className="text-rose-600">*</span> : null}
            {block.help ? <span className="block text-[11px] text-zinc-500 mt-0.5">{String(block.help)}</span> : null}
          </span>
        </label>
      );
    case 'multi_checkbox': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <Shell block={block}>
          <div className="mt-1 space-y-1">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={key} value={o.value} className="h-4 w-4 rounded border-zinc-300" />
                {o.label}
              </label>
            ))}
          </div>
        </Shell>
      );
    }
    case 'signature_typed':
      return (
        <Shell block={block}>
          {block.acknowledgment ? <p className="text-xs text-zinc-700 mb-1 whitespace-pre-wrap">{String(block.acknowledgment)}</p> : null}
          <input type="text" name={key} placeholder="Type your full name" className={inputCls + ' font-serif italic'} />
        </Shell>
      );

    case 'signature_drawn':
      return (
        <Shell block={block}>
          <p className="text-[11px] text-zinc-500 mt-1 italic">
            Signature pad disabled in test mode — a placeholder &ldquo;Test Signature&rdquo; will be recorded.
          </p>
          <input type="hidden" name={key} value="data:test-signature" />
        </Shell>
      );

    case 'file_upload':
      return (
        <Shell block={block}>
          <p className="text-[11px] text-zinc-500 mt-1 italic">
            File uploads are skipped in test mode — the dry-run report shows which fields would&rsquo;ve received files.
          </p>
        </Shell>
      );

    case 'student_applicability':
      return (
        <Shell block={block}>
          <p className="text-[11px] text-zinc-500 mt-1 italic">
            In test mode, this is recorded as &ldquo;all students.&rdquo;
          </p>
          <input type="hidden" name={key} value="all" />
        </Shell>
      );

    case 'pricing_select':
    case 'multi_pricing':
    case 'quantity_pricing':
    case 'tuition_calculator': {
      const options = (
        Array.isArray(block.options)
          ? (block.options as Array<{ label: string; amount_cents: number; value?: string; visible_when?: VisibleWhen }>)
          : []
      ).filter((o) => isOptionVisible(o.visible_when, responses));
      return (
        <Shell block={block}>
          <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm">
            <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-2">
              Pricing block ({type})
            </div>
            {options.length > 0 ? (
              <div className="space-y-1.5">
                {options.map((o, i) => (
                  <label key={i} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <input
                        type={type === 'multi_pricing' ? 'checkbox' : 'radio'}
                        name={key}
                        value={o.value ?? String(i)}
                      />
                      <span>{o.label}</span>
                    </span>
                    <span className="font-mono tabular-nums text-xs">
                      ${(Number(o.amount_cents ?? 0) / 100).toFixed(2)}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-emerald-800 italic">No options configured.</p>
            )}
          </div>
        </Shell>
      );
    }

    default:
      return (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>Unknown block type:</strong> <code>{type || '(none)'}</code>. Test submit will skip this field.
          </div>
        </div>
      );
  }
}

function Shell({ block, children }: { block: Block; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-800">
        {String(block.label ?? '')} {block.required ? <span className="text-rose-600">*</span> : null}
      </span>
      {block.help ? <span className="block text-[11px] text-zinc-500 mt-0.5">{String(block.help)}</span> : null}
      {children}
    </label>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-200';
