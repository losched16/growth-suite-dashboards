'use client';

// Thin wrapper around the same interactive form renderer used for
// test-mode form previews. Submits to the staff-requests endpoint
// instead of the test endpoint. After a successful submit, navigates
// to the teacher's "My Requests" view.

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

type Block = Record<string, unknown>;

export function StaffSubmitForm({
  formId, schema, returnTo,
}: {
  formId: string;
  schema: unknown[];
  returnTo: string;
}) {
  const router = useRouter();
  const blocks = Array.isArray(schema) ? (schema as Block[]) : [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData(e.currentTarget);
      fd.set('form_definition_id', formId);
      fd.set('return_to', returnTo);
      const r = await fetch('/api/school/staff-requests/submit', {
        method: 'POST',
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      router.push(j.redirect_to as string);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {blocks.map((b, i) => <Block key={i} block={b} />)}

      {err ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div><strong>Submission failed:</strong> {err}</div>
        </div>
      ) : null}

      <div className="flex items-center gap-3 border-t border-zinc-200 pt-4">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Submit request
        </button>
        <span className="text-xs text-zinc-500">
          Lexi gets an email instantly. You can track status in &ldquo;My recent requests.&rdquo;
        </span>
      </div>
    </form>
  );
}

// ── field renderers (matches TestSubmitForm structure but as a
// dependency-free local copy so this file is self-contained) ──
function Block({ block }: { block: Block }) {
  const type = String(block.type ?? '');
  const key = String(block.key ?? '');

  switch (type) {
    case 'header':
      return <h2 className="text-base font-semibold text-zinc-900 border-b border-zinc-100 pb-2">{String(block.text ?? '')}</h2>;
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
        <div className="mt-3 rounded-md bg-zinc-50 border-l-4 border-emerald-500 px-3 py-2">
          <h3 className="text-sm font-semibold text-zinc-900">{String(block.label ?? '')}</h3>
          {block.description ? <p className="mt-0.5 text-xs text-zinc-600">{String(block.description)}</p> : null}
        </div>
      );
    case 'text': case 'email': case 'tel': case 'url':
      return (
        <Shell block={block}>
          <input
            type={type === 'tel' ? 'tel' : type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
            name={key}
            required={!!block.required}
            placeholder={String(block.placeholder ?? '')}
            className={inputCls}
          />
        </Shell>
      );
    case 'textarea':
      return (
        <Shell block={block}>
          <textarea name={key} rows={Number(block.rows ?? 3)} required={!!block.required}
            placeholder={String(block.placeholder ?? '')} className={inputCls} />
        </Shell>
      );
    case 'number':
      return <Shell block={block}><input type="number" name={key} required={!!block.required} className={inputCls} /></Shell>;
    case 'date':
      return <Shell block={block}><input type="date" name={key} required={!!block.required} className={inputCls} /></Shell>;
    case 'select': {
      const options = (block.options as Array<{value: string; label: string}>) ?? [];
      return (
        <Shell block={block}>
          <select name={key} required={!!block.required} className={inputCls}>
            <option value="">— select —</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Shell>
      );
    }
    case 'radio': {
      const options = (block.options as Array<{value: string; label: string}>) ?? [];
      return (
        <Shell block={block}>
          <div className="mt-1 space-y-1">
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <input type="radio" name={key} value={o.value} required={!!block.required} className="h-4 w-4 text-emerald-600" />
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
          <input type="checkbox" name={key} value="1" required={!!block.required} className="mt-0.5 h-4 w-4 rounded border-zinc-300" />
          <span className="text-zinc-800">
            {String(block.label ?? '')} {block.required ? <span className="text-rose-600">*</span> : null}
            {block.help ? <span className="block text-[11px] text-zinc-500 mt-0.5">{String(block.help)}</span> : null}
          </span>
        </label>
      );
    case 'multi_checkbox': {
      const options = (block.options as Array<{value: string; label: string}>) ?? [];
      return (
        <Shell block={block}>
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
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
    case 'file_upload':
      return (
        <Shell block={block}>
          <p className="text-[11px] text-zinc-500 italic">File uploads are coming soon — describe the issue in text for now and reach out to Lexi directly if a photo is needed.</p>
        </Shell>
      );
    case 'quantity_grid':
      return <QuantityGrid block={block} />;
    default:
      return null;
  }
}

// Item × quantity grid. Rows are item names, columns are quantity
// options (typically 1-5). Teacher picks one column per row (or none).
// Each row submits as a separate FormData entry keyed
// `<groupKey>__<row_slug>` with the picked column value as a string.
// The submit endpoint reassembles into an object: { item_slug: qty, ... }.
function QuantityGrid({ block }: { block: Block }) {
  const groupKey = String(block.key ?? '');
  const rows = Array.isArray(block.rows) ? (block.rows as string[]) : [];
  const cols = Array.isArray(block.columns) ? (block.columns as Array<string | number>) : [1, 2, 3, 4, 5];
  const help = block.help ? String(block.help) : null;
  const sectionLabel = String(block.label ?? '');

  return (
    <fieldset className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
      <legend className="px-3 text-sm font-medium text-zinc-800">{sectionLabel}</legend>
      {help ? <p className="px-3 pb-2 text-[11px] text-zinc-500">{help}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-100 text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="text-left px-3 py-1.5 font-medium w-[55%]">Item</th>
              {cols.map((c) => (
                <th key={String(c)} className="text-center px-2 py-1.5 font-medium w-[9%]">
                  {String(c)}
                </th>
              ))}
              <th className="text-center px-2 py-1.5 font-medium w-[9%] text-zinc-400">—</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((row) => {
              const rowKey = slugifyRow(row);
              const inputName = `${groupKey}__${rowKey}`;
              return (
                <tr key={rowKey} className="hover:bg-zinc-50">
                  <td className="px-3 py-1.5 text-zinc-800">{row}</td>
                  {cols.map((c) => (
                    <td key={String(c)} className="text-center px-2 py-1.5">
                      <input
                        type="radio"
                        name={inputName}
                        value={String(c)}
                        className="h-4 w-4 text-emerald-600"
                      />
                    </td>
                  ))}
                  <td className="text-center px-2 py-1.5">
                    {/* Default = no quantity. Pre-checked so a row with
                        no selection submits a clean empty value. */}
                    <input
                      type="radio"
                      name={inputName}
                      value=""
                      defaultChecked
                      className="h-4 w-4 text-zinc-300"
                      title="Don't request this item"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}

function slugifyRow(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
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
