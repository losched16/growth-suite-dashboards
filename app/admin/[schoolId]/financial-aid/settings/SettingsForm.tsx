'use client';

// Client-side admin form for school_financial_aid_settings. Wires
// every column the operator can configure, with a preview of what
// parents will see in the portal.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Save, Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import type { FinancialAidSettings } from '@/lib/financial-aid/settings';

export function SettingsForm({
  schoolId, locationId, schoolName, initial, documentCatalog,
}: {
  schoolId: string;
  locationId: string;
  schoolName: string;
  initial: FinancialAidSettings;
  documentCatalog: Array<{ key: string; label: string; hint: string }>;
}) {
  const [s, setS] = useState<FinancialAidSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function patch<K extends keyof FinancialAidSettings>(k: K, v: FinancialAidSettings[K]) {
    setS((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  }
  function toggleDoc(key: string) {
    setS((prev) => {
      const has = prev.required_document_types.includes(key);
      return {
        ...prev,
        required_document_types: has
          ? prev.required_document_types.filter((k) => k !== key)
          : [...prev.required_document_types, key],
      };
    });
    setSaved(false);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/financial-aid/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_enabled: s.is_enabled,
          active_academic_year: s.active_academic_year,
          application_open: s.application_open,
          application_deadline: s.application_deadline,
          intro_copy_markdown: s.intro_copy_markdown,
          required_document_types: s.required_document_types,
          max_award_per_student_cents: s.max_award_per_student_cents,
          admin_notify_emails: s.admin_notify_emails,
          decision_letter_template: s.decision_letter_template,
          signature_name: s.signature_name,
          signature_title: s.signature_title,
          max_award_pct_of_tuition: s.max_award_pct_of_tuition,
          min_family_contribution_pct: s.min_family_contribution_pct,
          policy_notes: s.policy_notes,
          regional_col_multiplier: s.regional_col_multiplier,
          regional_col_label: s.regional_col_label,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); setBusy(false); return; }
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      {/* Master switch */}
      <Section title="Enable / Disable" subtitle="Master switch — controls everything below.">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={s.is_enabled}
            onChange={(e) => patch('is_enabled', e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300"
          />
          <div>
            <div className="font-medium text-slate-900">
              Financial aid is {s.is_enabled ? <span className="text-emerald-700">ENABLED</span> : <span className="text-slate-500">disabled</span>} for {schoolName}.
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              When enabled, the Financial Aid tab appears in every parent portal. When disabled, it&rsquo;s hidden entirely.
            </p>
          </div>
        </label>
      </Section>

      {/* Active year + open/closed + deadline */}
      <Section title="Year + window" subtitle="What year parents are applying for + whether they can still submit.">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <LabeledInput label="Active academic year">
            <input
              type="text"
              value={s.active_academic_year}
              onChange={(e) => patch('active_academic_year', e.target.value)}
              placeholder="2026-27"
              pattern="\d{4}-\d{2}"
              className={inputCls}
            />
          </LabeledInput>
          <LabeledInput label="Application open?">
            <select
              value={s.application_open ? '1' : '0'}
              onChange={(e) => patch('application_open', e.target.value === '1')}
              className={inputCls}
            >
              <option value="1">Open — accepting new applications</option>
              <option value="0">Closed — view only</option>
            </select>
          </LabeledInput>
          <LabeledInput label="Deadline (optional)">
            <input
              type="date"
              value={s.application_deadline ?? ''}
              onChange={(e) => patch('application_deadline', e.target.value || null)}
              className={inputCls}
            />
          </LabeledInput>
        </div>
      </Section>

      {/* Intro copy */}
      <Section title="Parent-facing intro copy" subtitle="Markdown shown at the top of the parent portal FA page. Explain your policy, timeline, and what's required.">
        <textarea
          value={s.intro_copy_markdown ?? ''}
          onChange={(e) => patch('intro_copy_markdown', e.target.value)}
          rows={6}
          placeholder={`Example:\n\nAt ${schoolName} we believe finances should never stand between a child and a great education. We award financial aid through a confidential committee review based on demonstrated need.\n\n**What to expect:**\n- Decisions within 3 weeks of submission\n- Award letters by ${s.active_academic_year} start\n- All information is confidential`}
          className={`${inputCls} font-mono text-xs leading-relaxed`}
        />
      </Section>

      {/* Required documents */}
      <Section title="Required documents" subtitle="Check every document type parents must upload to submit a complete application.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {documentCatalog.map((d) => {
            const checked = s.required_document_types.includes(d.key);
            return (
              <label
                key={d.key}
                className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer text-sm ${
                  checked ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleDoc(d.key)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <div>
                  <div className="font-medium text-slate-900">{d.label}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{d.hint}</div>
                </div>
              </label>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-500 italic mt-2">
          Parents can always upload additional supporting docs beyond what&rsquo;s required.
        </p>
      </Section>

      {/* Notify + ceiling */}
      <Section title="Admin notifications + sanity ceiling" subtitle="Who gets emailed when new applications arrive + the max per-student award an admin can enter.">
        <div className="space-y-3">
          <LabeledInput label="Admin notify emails (comma-separated)">
            <input
              type="text"
              value={s.admin_notify_emails.join(', ')}
              onChange={(e) => patch('admin_notify_emails', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))}
              placeholder="aid@school.org, head@school.org"
              className={inputCls}
            />
          </LabeledInput>
          <LabeledInput label="Max award per student (sanity check)">
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500">$</span>
              <input
                type="number"
                min={0}
                step={500}
                value={Math.round(s.max_award_per_student_cents / 100)}
                onChange={(e) => patch('max_award_per_student_cents', Math.max(0, Number(e.target.value) || 0) * 100)}
                className={`${inputCls} max-w-[140px]`}
              />
            </div>
          </LabeledInput>
        </div>
      </Section>

      {/* Policy caps the AI applies AFTER recommending */}
      <Section title="Award policy caps" subtitle="Hard ceilings the AI applies AFTER computing its expert recommendation. Lets you say things like 'we never give more than 50% of tuition.' The committee always sees both numbers (unrestricted + post-policy).">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabeledInput label="Max award (% of student's tuition)">
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={100} step={1}
                value={s.max_award_pct_of_tuition != null ? Math.round(s.max_award_pct_of_tuition * 100) : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  patch('max_award_pct_of_tuition', v === '' ? null : Math.max(0, Math.min(100, Number(v))) / 100);
                }}
                placeholder="e.g. 50"
                className={`${inputCls} max-w-[100px]`}
              />
              <span className="text-sm text-slate-500">%</span>
              <span className="text-[11px] text-slate-500 italic">Blank = no cap</span>
            </div>
          </LabeledInput>
          <LabeledInput label="Min family contribution (% of tuition)">
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={100} step={1}
                value={s.min_family_contribution_pct != null ? Math.round(s.min_family_contribution_pct * 100) : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  patch('min_family_contribution_pct', v === '' ? null : Math.max(0, Math.min(100, Number(v))) / 100);
                }}
                placeholder="e.g. 20"
                className={`${inputCls} max-w-[100px]`}
              />
              <span className="text-sm text-slate-500">%</span>
              <span className="text-[11px] text-slate-500 italic">Family always pays at least this much</span>
            </div>
          </LabeledInput>
        </div>
        <div className="mt-3">
          <LabeledInput label="Policy notes for the AI (free-text)">
            <textarea
              value={s.policy_notes ?? ''}
              onChange={(e) => patch('policy_notes', e.target.value || null)}
              rows={3}
              placeholder={'e.g.\n- Faculty children receive a 50% tuition remission, not an FA award\n- Awards above $20K require board approval — flag those in concerns\n- We prioritize sibling-of-existing-student applicants'}
              className={`${inputCls} text-xs leading-relaxed`}
            />
          </LabeledInput>
        </div>
      </Section>

      {/* Cost of living */}
      <Section title="Cost of living context" subtitle="Helps the AI sanity-check the family's reported expenses against typical costs in your region. Leave the multiplier at 1.0 if you don't want it adjusted.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabeledInput label="Regional COL multiplier vs US average">
            <div className="flex items-center gap-2">
              <input
                type="number" min={0.5} max={2.5} step={0.05}
                value={s.regional_col_multiplier ?? 1.0}
                onChange={(e) => patch('regional_col_multiplier', Number(e.target.value) || 1.0)}
                className={`${inputCls} max-w-[100px]`}
              />
              <span className="text-[11px] text-slate-500 italic">1.0 = US avg · 1.3 = Phoenix/Denver · 1.6 = Bay Area / NYC</span>
            </div>
          </LabeledInput>
          <LabeledInput label="Regional label">
            <input
              type="text"
              value={s.regional_col_label ?? ''}
              onChange={(e) => patch('regional_col_label', e.target.value || null)}
              placeholder="e.g. Phoenix metro — moderate COL"
              className={inputCls}
            />
          </LabeledInput>
        </div>
      </Section>

      {/* Decision letter template */}
      <Section title="Decision letter (PDF) template" subtitle="Markdown with {{placeholders}}. Used when an admin generates a decision letter from the queue. Leave blank to use the generic Growth Suite template.">
        <textarea
          value={s.decision_letter_template ?? ''}
          onChange={(e) => patch('decision_letter_template', e.target.value)}
          rows={8}
          placeholder={`Example template:\n\nDear {{family_name}},\n\nThank you for applying for financial aid at {{school_name}} for the {{academic_year}} academic year.\n\nWe are pleased to offer the following aid for your enrolled students:\n\n{{student_list}}\n\nTotal annual award: {{total_award}}\n\n{{decision_note}}\n\nWarmly,\n{{signature_name}}\n{{signature_title}}`}
          className={`${inputCls} font-mono text-xs leading-relaxed`}
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <LabeledInput label="Signature name">
            <input type="text" value={s.signature_name ?? ''} onChange={(e) => patch('signature_name', e.target.value || null)} className={inputCls} />
          </LabeledInput>
          <LabeledInput label="Signature title">
            <input type="text" value={s.signature_title ?? ''} onChange={(e) => patch('signature_title', e.target.value || null)} className={inputCls} />
          </LabeledInput>
        </div>
      </Section>

      {/* Submit */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200">
        <div className="flex items-center gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 text-sm">
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          ) : null}
          {err ? (
            <span className="inline-flex items-center gap-1 text-rose-700 text-sm">
              <AlertCircle className="h-4 w-4" /> {err}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/school/${locationId}/financial-aid?chrome=none`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Preview FA queue
          </Link>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
          </button>
        </div>
      </div>
    </form>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="text-xs text-slate-500 mt-0.5 mb-3">{subtitle}</p>
      {children}
    </section>
  );
}

function LabeledInput({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls = 'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-200';
