// Preview-only form renderer. Mirrors the parent-portal FormRenderer
// visually for the common block types but DOES NOT submit. This way
// operators can eyeball form layout before publishing without having
// to log in as a parent.
//
// Field-by-field parity with the production renderer is best-effort;
// when a new block type ships, add it here too. Anything unknown
// renders as a yellow "Unknown block type" callout so the operator
// knows their schema has something the preview can't handle.

import { AlertCircle, PenTool, Upload, ChevronRight } from 'lucide-react';

// We don't import the production FormFieldBlock type because it lives
// in the parent-portal package. The schema is plain JSONB anyway.
type Block = Record<string, unknown>;

export function FormPreviewRenderer({ schema }: { schema: unknown[] }) {
  const blocks = Array.isArray(schema) ? (schema as Block[]) : [];

  if (blocks.length === 0) {
    return (
      <div className="rounded-md border-2 border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">
        This form has no fields yet. Use the editor to add some.
      </div>
    );
  }

  // Server component: cannot pass event handlers. The wrapping <form>
  // has no action and every interactive child is disabled, so there's
  // nothing for the browser to submit even without an onSubmit guard.
  // Using a <div> avoids the "Event handlers cannot be passed to Client
  // Component props" runtime error that an `onSubmit` would trigger.
  return (
    <div className="space-y-5">
      {blocks.map((block, i) => <BlockRender key={i} block={block} />)}
    </div>
  );
}

function BlockRender({ block }: { block: Block }) {
  const type = String(block.type ?? '');
  switch (type) {
    case 'header':
      return <h2 className="text-lg font-semibold text-zinc-900 border-b border-zinc-100 pb-2">{String(block.text ?? '')}</h2>;

    case 'paragraph': {
      const emphasis = block.emphasis as string | undefined;
      const cls =
        emphasis === 'warning' ? 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900' :
        emphasis === 'note'    ? 'rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700' :
                                 'text-sm text-zinc-700 whitespace-pre-wrap';
      return <p className={cls}>{String(block.text ?? '')}</p>;
    }

    case 'section':
      return (
        <div className="mt-4 rounded-md bg-zinc-50 border-l-4 border-emerald-500 px-3 py-2">
          <h3 className="text-base font-semibold text-zinc-900">{String(block.label ?? '')}</h3>
          {block.description ? (
            <p className="mt-0.5 text-xs text-zinc-600">{String(block.description)}</p>
          ) : null}
        </div>
      );

    case 'text':
    case 'email':
    case 'tel':
    case 'url':
      return (
        <FieldShell block={block}>
          <input
            type={type === 'tel' ? 'tel' : type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
            placeholder={String(block.placeholder ?? '')}
            disabled
            className={inputCls}
          />
        </FieldShell>
      );

    case 'textarea':
      return (
        <FieldShell block={block}>
          <textarea
            rows={Number(block.rows ?? 3)}
            placeholder={String(block.placeholder ?? '')}
            disabled
            className={inputCls}
          />
        </FieldShell>
      );

    case 'number':
      return (
        <FieldShell block={block}>
          <input type="number" placeholder={String(block.placeholder ?? '')} disabled className={inputCls} />
        </FieldShell>
      );

    case 'date':
      return (
        <FieldShell block={block}>
          <input type="date" disabled className={inputCls} />
        </FieldShell>
      );

    case 'select': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <FieldShell block={block}>
          <select disabled className={inputCls}>
            <option value="">— select —</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FieldShell>
      );
    }

    case 'radio': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <FieldShell block={block}>
          <div className="mt-1 space-y-1">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="radio" disabled className="h-4 w-4 text-emerald-600" />
                {o.label}
              </label>
            ))}
          </div>
        </FieldShell>
      );
    }

    case 'checkbox':
      return (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" disabled className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
          <span className="text-zinc-800">
            {String(block.label ?? '')} {block.required ? <span className="text-rose-600">*</span> : null}
            {block.help ? <span className="block text-[11px] text-zinc-500 mt-0.5">{String(block.help)}</span> : null}
          </span>
        </label>
      );

    case 'multi_checkbox': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ value: string; label: string }>) : [];
      return (
        <FieldShell block={block}>
          <div className="mt-1 space-y-1">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled className="h-4 w-4 rounded border-zinc-300" />
                {o.label}
              </label>
            ))}
          </div>
        </FieldShell>
      );
    }

    case 'student_applicability':
      // In the real renderer this pulls the family's students. In preview,
      // mock 2 students so the operator sees what it'll look like.
      return (
        <FieldShell block={block}>
          <div className="mt-1 space-y-1.5 rounded-md border border-zinc-200 bg-zinc-50/40 px-3 py-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" defaultChecked disabled className="h-4 w-4 rounded border-zinc-300" />
              <span>All students in our family (2)</span>
            </label>
            <div className="ml-6 space-y-1 opacity-50">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled className="h-4 w-4 rounded border-zinc-300" />
                Charlie Sample
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled className="h-4 w-4 rounded border-zinc-300" />
                Sam Sample
              </label>
            </div>
          </div>
        </FieldShell>
      );

    case 'file_upload':
      return (
        <FieldShell block={block}>
          <div className="mt-1 flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-500">
            <Upload className="h-4 w-4" />
            <span>Choose file… (disabled in preview)</span>
          </div>
        </FieldShell>
      );

    case 'signature_drawn':
      return (
        <FieldShell block={block}>
          <div className="mt-1 rounded-md border-2 border-dashed border-zinc-300 bg-white">
            <div className="flex h-40 items-center justify-center text-zinc-400">
              <PenTool className="h-5 w-5 mr-2" />
              <span className="text-xs">Signature pad — parent draws here</span>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" disabled className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs opacity-40">
              Clear
            </button>
            <button type="button" disabled className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-semibold text-white opacity-40">
              Lock signature
            </button>
          </div>
        </FieldShell>
      );

    case 'signature_typed':
      return (
        <FieldShell block={block}>
          {block.acknowledgment ? (
            <p className="text-xs text-zinc-700 mb-1 whitespace-pre-wrap">{String(block.acknowledgment)}</p>
          ) : null}
          <input type="text" placeholder="Type your full name" disabled className={inputCls + ' font-serif italic'} />
        </FieldShell>
      );

    case 'pricing_select':
    case 'multi_pricing':
    case 'quantity_pricing':
    case 'tuition_calculator': {
      const options = Array.isArray(block.options) ? (block.options as Array<{ label: string; amount_cents: number }>) : [];
      return (
        <FieldShell block={block}>
          <div className="mt-1 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm">
            <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
              Pricing block ({type})
            </div>
            {options.length > 0 ? (
              <ul className="space-y-1">
                {options.slice(0, 5).map((o, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span>{o.label}</span>
                    <span className="font-mono tabular-nums">
                      {o.amount_cents != null ? `$${(Number(o.amount_cents) / 100).toFixed(2)}` : ''}
                    </span>
                  </li>
                ))}
                {options.length > 5 ? (
                  <li className="text-[10px] text-emerald-700 italic">+ {options.length - 5} more options</li>
                ) : null}
              </ul>
            ) : (
              <p className="text-[11px] text-emerald-800">
                Renders as a {type === 'quantity_pricing' ? 'quantity selector' : type === 'tuition_calculator' ? 'tuition calculator widget' : 'pricing picker'} in the live form.
              </p>
            )}
          </div>
        </FieldShell>
      );
    }

    default:
      return (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <strong>Unknown block type:</strong> <code>{type || '(none)'}</code>.
            The live parent portal may still render this — preview just doesn&rsquo;t know about it yet.
          </div>
        </div>
      );
  }
}

const inputCls =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-zinc-50/40 px-3 py-2 text-sm cursor-not-allowed';

function FieldShell({ block, children }: { block: Block; children: React.ReactNode }) {
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
