'use client';

// Self-serve editor for the school's tuition add-on rate card
// (schools.settings.addon_catalog). Three categories — Extended Care,
// Deposit, Development Fee — each an editable list of {label, amount} rows
// the operator can add / edit / remove. Amounts are entered as positive
// dollar magnitudes; the deposit category is stored as a CREDIT (negative)
// on save. POSTs the whole catalog as JSON to the save API.
//
// These options feed the "Enroll a family" builder's add-on pickers, so a
// rate change here immediately changes what operators can select.

import { useState } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import type { AddonCatalog, AddonCategory } from '@/lib/billing/addon-catalog';

interface Row { id: string; label: string; dollars: string }

// Category → whether its amounts are credits (stored negative).
const IS_CREDIT: Record<AddonCategory, boolean> = {
  extended_care: false,
  deposit: true,
  development_fee: false,
};

const SECTIONS: Array<{ key: AddonCategory; title: string; hint: string; labelPlaceholder: string }> = [
  { key: 'extended_care', title: 'Extended Care', hint: 'Added on top of tuition. One row per hours × days-per-week tier.', labelPlaceholder: 'Extended care (2–3 hours, 3 days/week)' },
  { key: 'deposit', title: 'Deposit (credit)', hint: 'Credited against tuition — enter the amount as a positive number; it’s applied as a credit.', labelPlaceholder: 'Deposit (paid) — Child 1' },
  { key: 'development_fee', title: 'Development Fee', hint: 'Added on top of tuition.', labelPlaceholder: 'Development fee' },
];

function toRows(opts: AddonCatalog[AddonCategory]): Row[] {
  return opts.map((o) => ({ id: o.id, label: o.label, dollars: (Math.abs(o.amount_cents) / 100).toString() }));
}

export function AddonCatalogEditor({
  schoolId, locationId, catalog,
}: {
  schoolId: string;
  locationId: string;
  catalog: AddonCatalog;
}) {
  const [rowsByCat, setRowsByCat] = useState<Record<AddonCategory, Row[]>>({
    extended_care: toRows(catalog.extended_care),
    deposit: toRows(catalog.deposit),
    development_fee: toRows(catalog.development_fee),
  });
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);

  function update(cat: AddonCategory, i: number, patch: Partial<Row>) {
    setRowsByCat((prev) => {
      const next = { ...prev, [cat]: prev[cat].map((r, idx) => (idx === i ? { ...r, ...patch } : r)) };
      return next;
    });
  }
  function addRow(cat: AddonCategory) {
    // Stable-ish id from a counter; the server re-normalizes and dedupes.
    const rid = `${cat}_${rowsByCat[cat].length + 1}_${Math.abs(hashStr(cat + rowsByCat[cat].length))}`;
    setRowsByCat((prev) => ({ ...prev, [cat]: [...prev[cat], { id: rid, label: '', dollars: '' }] }));
  }
  function removeRow(cat: AddonCategory, i: number) {
    setRowsByCat((prev) => ({ ...prev, [cat]: prev[cat].filter((_, idx) => idx !== i) }));
  }

  async function save() {
    setSaving(true);
    setFlash(null);
    // Assemble the catalog: apply the credit sign per category, drop blank
    // rows, coerce dollars → integer cents.
    const build = (cat: AddonCategory) =>
      rowsByCat[cat]
        .map((r) => {
          const label = r.label.trim();
          const dollars = Number(r.dollars);
          if (!label || !Number.isFinite(dollars)) return null;
          const cents = Math.round(Math.abs(dollars) * 100) * (IS_CREDIT[cat] ? -1 : 1);
          return { id: r.id.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, amount_cents: cents };
        })
        .filter(Boolean);
    const payload = {
      extended_care: build('extended_care'),
      deposit: build('deposit'),
      development_fee: build('development_fee'),
    };
    try {
      const res = await fetch(`/api/school/${locationId}/addon-catalog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolId, catalog: payload }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setFlash({ ok: true, msg: 'Rate card saved. New enrollments will use these amounts.' });
    } catch (e) {
      setFlash({ ok: false, msg: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Add-on rate card</h2>
        <p className="text-sm text-slate-500">
          Extended-care tiers, deposit, and development fee that appear in the <strong>Enroll a family</strong> builder.
          Edit an amount and it’s used on every new enrollment.
        </p>
      </div>

      {flash ? (
        <div className={`rounded-md border px-3 py-2 text-sm ${flash.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          {flash.msg}
        </div>
      ) : null}

      {SECTIONS.map((sec) => (
        <section key={sec.key} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <h3 className="text-sm font-semibold text-slate-900">{sec.title}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">{sec.hint}</p>
          </div>
          <div className="divide-y divide-slate-100">
            {rowsByCat[sec.key].length === 0 ? (
              <div className="px-4 py-3 text-xs text-slate-400 italic">No rows yet — add one below.</div>
            ) : rowsByCat[sec.key].map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-2">
                <input
                  type="text"
                  value={r.label}
                  placeholder={sec.labelPlaceholder}
                  onChange={(e) => update(sec.key, i, { label: e.target.value })}
                  className="flex-1 min-w-0 rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                />
                <div className="flex items-center gap-1">
                  <span className="text-slate-400 text-sm">$</span>
                  <input
                    type="number" min="0" step="1"
                    value={r.dollars}
                    placeholder="0"
                    onChange={(e) => update(sec.key, i, { dollars: e.target.value })}
                    className="w-28 rounded border border-slate-300 px-2 py-1.5 text-sm text-right tabular-nums focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <button type="button" onClick={() => removeRow(sec.key, i)}
                  className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Remove row">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 bg-slate-50/50 border-t border-slate-100">
            <button type="button" onClick={() => addRow(sec.key)}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900">
              <Plus className="h-3.5 w-3.5" /> Add {sec.title.toLowerCase()} row
            </button>
          </div>
        </section>
      ))}

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save rate card'}
        </button>
        <span className="text-[11px] text-slate-500">Changes apply to new enrollments only; existing plans are untouched.</span>
      </div>
    </div>
  );
}

// Tiny deterministic hash for a stable-ish new-row id (avoids Math.random,
// keeps re-renders steady). Not security-sensitive.
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
