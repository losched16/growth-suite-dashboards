'use client';

// Accordion queue for FA applications. One row per family per year. The
// expanded panel shows household financials + a row per student with
// inputs to set the recommended award per student. Saves to
// /api/school/fa-applications/set-award which writes BOTH the
// application-level decision and the per-student awards atomically.

import { useState } from 'react';
import { ChevronRight, ChevronDown, FileText, ExternalLink, Users, Printer, Sparkles, Loader2, AlertCircle, CheckCircle2, ChevronUp } from 'lucide-react';
import type { FaApplicationRow, FaStudentRow } from './fetcher';

const EMDASH = '—';

export function QueueTable({
  rows,
  locationId,
  crmAppBase,
  schoolId,
  awardFloor,
  awardCeiling,
}: {
  rows: FaApplicationRow[];
  locationId: string;
  crmAppBase: string;
  schoolId: string;
  awardFloor: number;
  awardCeiling: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        No applications match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2 font-medium">Family</th>
            <th className="px-3 py-2 font-medium">Students</th>
            <th className="px-3 py-2 font-medium">Parent contact</th>
            <th className="px-3 py-2 font-medium">Year</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium text-right">Requested</th>
            <th className="px-3 py-2 font-medium text-right">Awarded</th>
            <th className="px-3 py-2 font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((a) => {
            const open = expanded === a.id;
            return (
              <Row
                key={a.id}
                app={a}
                expanded={open}
                onToggle={() => setExpanded(open ? null : a.id)}
                locationId={locationId}
                crmAppBase={crmAppBase}
                schoolId={schoolId}
                awardFloor={awardFloor}
                awardCeiling={awardCeiling}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  app: a,
  expanded,
  onToggle,
  locationId,
  crmAppBase,
  schoolId,
  awardFloor,
  awardCeiling,
}: {
  app: FaApplicationRow;
  expanded: boolean;
  onToggle: () => void;
  locationId: string;
  crmAppBase: string;
  schoolId: string;
  awardFloor: number;
  awardCeiling: number;
}) {
  const studentSummary = a.students.length === 1
    ? `${a.students[0].first_name} ${a.students[0].last_name}`
    : `${a.students.length} students`;
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer ${expanded ? 'bg-emerald-50/50' : 'hover:bg-gray-50'}`}
      >
        <td className="px-2 py-2 align-top text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2 align-top">
          <div className="font-medium text-gray-900">{a.family_display_name}</div>
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700">
          <div className="flex items-center gap-1">
            <Users className="h-3 w-3 text-gray-400" /> {studentSummary}
          </div>
          {a.students.length > 1 ? (
            <div className="text-[10px] text-gray-500 truncate max-w-[20ch]">
              {a.students.map((s) => s.first_name).join(', ')}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-600">
          <div>{a.parent_name}</div>
          {a.parent_email ? <div className="truncate max-w-[20ch]">{a.parent_email}</div> : null}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-700">{a.academic_year}</td>
        <td className="px-3 py-2 align-top">
          <StatusBadge status={a.status} />
        </td>
        <td className="px-3 py-2 align-top text-right tabular-nums font-medium">
          {a.total_requested > 0 ? fmtMoney(a.total_requested) : EMDASH}
        </td>
        <td className="px-3 py-2 align-top text-right tabular-nums font-medium">
          {a.total_recommended > 0
            ? <span className="text-emerald-700">{fmtMoney(a.total_recommended)}</span>
            : <span className="text-gray-400">{EMDASH}</span>}
        </td>
        <td className="px-3 py-2 align-top text-[11px] text-gray-500">
          {a.submitted_at ? fmtDate(a.submitted_at) : EMDASH}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={9} className="bg-gray-50 p-0 border-y border-emerald-200">
            <DetailPanel
              app={a}
              locationId={locationId}
              crmAppBase={crmAppBase}
              schoolId={schoolId}
              awardFloor={awardFloor}
              awardCeiling={awardCeiling}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailPanel({
  app: a,
  locationId,
  crmAppBase,
  schoolId,
  awardFloor,
  awardCeiling,
}: {
  app: FaApplicationRow;
  schoolId: string;
  locationId: string;
  crmAppBase: string;
  awardFloor: number;
  awardCeiling: number;
}) {
  const contactUrl = a.parent_ghl_contact_id
    ? `${crmAppBase}/v2/location/${locationId}/contacts/detail/${a.parent_ghl_contact_id}`
    : null;
  const incomePerHead = a.household_size && a.household_size > 0
    ? a.total_annual_income / a.household_size : 0;
  const tuitionPctIncome = a.total_annual_income > 0
    ? (a.total_current_tuition / a.total_annual_income) * 100 : 0;
  const requestedPctTuition = a.total_current_tuition > 0
    ? (a.total_requested / a.total_current_tuition) * 100 : 0;

  return (
    <div className="px-6 py-5 space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-sm">
        {/* Family info */}
        <div className="space-y-1">
          <SectionLabel>Family</SectionLabel>
          <div className="text-gray-900 font-medium">{a.family_display_name}</div>
          <div className="text-gray-700 text-xs">Parent: {a.parent_name}</div>
          {a.parent_email ? <div className="text-gray-700 text-xs break-all">{a.parent_email}</div> : null}
          {a.parent_phone ? <div className="text-gray-700 text-xs">{a.parent_phone}</div> : null}
          {contactUrl ? (
            <a
              href={contactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Open Full Contact Record →
            </a>
          ) : null}
        </div>

        {/* Household-level financials */}
        <div className="space-y-1">
          <SectionLabel>Household financials</SectionLabel>
          <KV k="Household size" v={a.household_size ? String(a.household_size) : EMDASH} />
          <KV k="Annual income" v={a.total_annual_income > 0 ? fmtMoney(a.total_annual_income) : EMDASH} />
          <KV k="Assets" v={a.assets_value > 0 ? fmtMoney(a.assets_value) : EMDASH} />
          <KV k="Total tuition (all kids)" v={a.total_current_tuition > 0 ? fmtMoney(a.total_current_tuition) : EMDASH} />
          <KV k="Total requested" v={a.total_requested > 0 ? fmtMoney(a.total_requested) : EMDASH} bold />
        </div>

        {/* Quick math */}
        <div className="space-y-1">
          <SectionLabel>Quick math</SectionLabel>
          <KV k="Per-person income" v={incomePerHead > 0 ? fmtMoney(incomePerHead) : EMDASH} />
          <KV k="Tuition % income" v={tuitionPctIncome > 0 ? `${tuitionPctIncome.toFixed(1)}%` : EMDASH} />
          <KV k="Requested % tuition" v={requestedPctTuition > 0 ? `${requestedPctTuition.toFixed(0)}%` : EMDASH} />
          {a.decided_at ? (
            <div className="mt-2 text-[11px] text-gray-500">
              Decided {fmtDate(a.decided_at)} by {a.decided_by ?? 'admin'}
            </div>
          ) : null}
          {a.status === 'decided' && a.total_recommended > 0 ? (
            <FaToDiscountButton
              schoolId={schoolId}
              applicationId={a.id}
              familyDisplayName={a.family_display_name}
              awardDollars={a.total_recommended}
              academicYear={a.academic_year}
            />
          ) : null}
        </div>
      </div>

      {a.special_circumstances || a.parent_notes ? (
        <div className="rounded-md border border-gray-100 bg-white p-3 space-y-2 text-sm">
          <SectionLabel>Family narrative</SectionLabel>
          {a.special_circumstances ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500">Special circumstances</div>
              <p className="text-gray-800 whitespace-pre-wrap">{a.special_circumstances}</p>
            </div>
          ) : null}
          {a.parent_notes ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500">Additional notes</div>
              <p className="text-gray-800 whitespace-pre-wrap">{a.parent_notes}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-md border border-gray-100 bg-white">
        <div className="px-3 py-1.5 border-b border-gray-100 text-[11px] uppercase tracking-wide text-gray-500 font-semibold">
          Supporting documents ({a.files.length})
        </div>
        {a.files.length === 0 ? (
          <div className="p-3 text-xs text-gray-500 italic">No documents uploaded.</div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {a.files.map((f) => (
              <li key={f.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                <FileText className="h-3.5 w-3.5 text-gray-400" />
                <span className="text-gray-800">{f.display_name}</span>
                <span className="text-gray-400">{f.document_type ? `(${f.document_type})` : ''}</span>
                <span className="text-gray-400">{fmtSize(f.size_bytes)}</span>
                <a
                  href={`/api/school/fa-applications/file?id=${f.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-0.5 text-emerald-700 hover:underline"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* AI committee analysis (top-of-funnel — drives everything below) */}
      <AiAnalysisPanel applicationId={a.id} initial={a.ai_analysis} analyzedAt={a.ai_analyzed_at} model={a.ai_analysis_model} />

      {/* Per-student awards + final decision */}
      <AwardForm app={a} awardFloor={awardFloor} awardCeiling={awardCeiling} />
    </div>
  );
}

function AwardForm({
  app: a,
  awardFloor,
  awardCeiling,
}: {
  app: FaApplicationRow;
  awardFloor: number;
  awardCeiling: number;
}) {
  const [studentAwards, setStudentAwards] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const s of a.students) {
      init[s.id] = s.recommended_award !== null ? String(s.recommended_award) : '';
    }
    return init;
  });
  const [studentNotes, setStudentNotes] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const s of a.students) init[s.id] = s.award_note ?? '';
    return init;
  });
  const [familyNote, setFamilyNote] = useState<string>(a.decision_note ?? '');
  // 'submitted' isn't an option in the dropdown — it's the auto-set
  // state the parent portal writes. We bump the default to
  // 'under_review' so an admin opening a fresh app sees a sensible
  // next-step value (legacy 'reviewing' is also remapped here).
  const initialStatus = a.status === 'submitted' || a.status === 'reviewing' ? 'under_review' : a.status;
  const [status, setStatus] = useState<string>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const totalAward = Object.values(studentAwards).reduce((sum, v) => {
    const n = Number(v);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  async function save(decide: boolean) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('application_id', a.id);
      fd.set('status', decide ? 'decided' : status);
      fd.set('decision_note', familyNote);
      // Per-student awards
      for (const s of a.students) {
        fd.set(`award_${s.id}`, studentAwards[s.id] ?? '');
        fd.set(`note_${s.id}`, studentNotes[s.id] ?? '');
      }
      const r = await fetch('/api/school/fa-applications/set-award', { method: 'POST', body: fd });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || 'failed');
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border-2 border-emerald-200 bg-emerald-50/40 p-3 space-y-3">
      <SectionLabel>Set recommended award per student</SectionLabel>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[10px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-2 py-1">Student</th>
              <th className="px-2 py-1 text-right">Tuition</th>
              <th className="px-2 py-1 text-right">Requested</th>
              <th className="px-2 py-1">Recommended award ($)</th>
              <th className="px-2 py-1">Per-student note (optional)</th>
            </tr>
          </thead>
          <tbody>
            {a.students.map((s) => (
              <tr key={s.id} className="border-t border-emerald-100">
                <td className="px-2 py-1.5">
                  <div className="font-medium text-gray-900">{s.first_name} {s.last_name}</div>
                  {s.grade ? <div className="text-[10px] text-gray-500">grade {s.grade}</div> : null}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(s.current_tuition)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(s.requested_aid)}</td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={awardFloor}
                    max={awardCeiling}
                    value={studentAwards[s.id] ?? ''}
                    onChange={(e) => setStudentAwards((m) => ({ ...m, [s.id]: e.target.value }))}
                    className="w-32 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
                    placeholder={`${awardFloor}–${awardCeiling}`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={studentNotes[s.id] ?? ''}
                    onChange={(e) => setStudentNotes((m) => ({ ...m, [s.id]: e.target.value }))}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
                    placeholder="e.g. Continuing student priority"
                  />
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-emerald-200 font-semibold">
              <td className="px-2 py-1.5 text-right text-gray-700" colSpan={3}>Family total awarded:</td>
              <td className="px-2 py-1.5 tabular-nums text-emerald-700">{fmtMoney(totalAward)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="space-y-1 md:col-span-2">
          <span className="text-xs text-gray-600">Family-level decision note (visible to the parent)</span>
          <textarea
            value={familyNote}
            onChange={(e) => setFamilyNote(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
            placeholder="e.g. Award is contingent on completing financial terms agreement by Jul 15…"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-gray-600">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none"
          >
            <option value="under_review">Under review</option>
            <option value="decided">Decided</option>
            <option value="declined">Declined</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </label>
      </div>

      {err ? <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">{err}</div> : null}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => save(false)}
          disabled={busy}
          className="rounded-md border border-emerald-600 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          onClick={() => save(true)}
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Mark as Decided'}
        </button>
        {/* Print decision letter — opens the HTML letter rendered
            from the school's template in a new tab; the admin uses
            the browser print dialog (or the in-page button) to save
            it as PDF. Only meaningful once the decision is recorded,
            so we disable until status === 'decided'. */}
        <a
          href={`/api/school/fa-applications/${a.id}/letter`}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={a.status !== 'decided'}
          onClick={(e) => { if (a.status !== 'decided') e.preventDefault(); }}
          title={a.status !== 'decided'
            ? 'Mark this application as Decided first — then you can print the letter.'
            : 'Open a print-ready decision letter in a new tab.'}
          className={
            a.status === 'decided'
              ? 'inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'
              : 'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400 cursor-not-allowed'
          }
        >
          <Printer className="h-3.5 w-3.5" /> Print decision letter
        </a>
      </div>
    </div>
  );
}

// One-click "make this FA award into a discount policy" button. Posts
// to the dashboards API, which creates a discount_policies row keyed to
// this fa_applications.id. Future invoices for the family automatically
// pick it up via evaluateDiscounts().
function FaToDiscountButton({
  schoolId, applicationId, familyDisplayName, awardDollars, academicYear,
}: {
  schoolId: string;
  applicationId: string;
  familyDisplayName: string;
  awardDollars: number;
  academicYear: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | { err: string }>('idle');

  async function create() {
    if (state === 'busy') return;
    setState('busy');
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/payments/fa-to-discount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fa_application_id: applicationId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || j.detail || `HTTP ${r.status}`);
      }
      setState('done');
    } catch (e) {
      setState({ err: e instanceof Error ? e.message : String(e) });
    }
  }

  if (state === 'done') {
    return (
      <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-800">
        ✓ FA discount created. Future invoices for {familyDisplayName} ({academicYear}) will auto-apply ${awardDollars.toLocaleString()} off tuition.
      </div>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={create}
        disabled={state === 'busy'}
        className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
      >
        {state === 'busy' ? 'Creating…' : `Create FA discount ($${awardDollars.toLocaleString()})`}
      </button>
      {typeof state === 'object' && 'err' in state ? (
        <div className="mt-1 text-[11px] text-rose-700">{state.err}</div>
      ) : null}
      <p className="mt-1 text-[10px] text-gray-500">
        Adds this award as an auto-apply discount on the family&rsquo;s future tuition invoices.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'submitted'   ? 'bg-amber-100 text-amber-800' :
    status === 'reviewing'   ? 'bg-blue-100 text-blue-800' :
    status === 'decided'     ? 'bg-emerald-100 text-emerald-800' :
    status === 'under_review'? 'bg-violet-100 text-violet-800' :
    status === 'declined'    ? 'bg-rose-100 text-rose-800' :
    status === 'withdrawn'   ? 'bg-zinc-200 text-zinc-700' :
                                'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">{children}</div>;
}

function KV({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-gray-500">{k}</span>
      <span className={bold ? 'font-semibold text-gray-900 tabular-nums' : 'text-gray-800 tabular-nums'}>{v}</span>
    </div>
  );
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// We import this lazily so the FaStudentRow type-only import doesn't
// drop and cause "unused" warnings. (Type stays in fetcher.ts.)
export type _StudentRowLocal = FaStudentRow;

// ── Claude-powered FA analysis panel ────────────────────────────────
// Shown above the AwardForm. If no analysis exists yet, renders a
// "Generate AI analysis" CTA. Once generated, shows the structured
// committee briefing: executive summary, financial snapshot, signals,
// per-student recommendation range, suggested decision-note draft.
// Operator can regenerate.
interface AnalysisShape {
  executive_summary?: string;
  financial_snapshot?: {
    annual_income_cents?: number | null;
    annual_expenses_cents?: number | null;
    discretionary_capacity_cents?: number | null;
    savings_runway_months?: number | null;
    debt_burden_label?: 'low' | 'moderate' | 'high' | 'unknown';
    housing_burden_label?: 'low' | 'moderate' | 'high' | 'unknown';
  };
  demonstrated_need_assessment?: string;
  positives?: string[];
  concerns?: string[];
  recommended_awards?: Array<{
    student_id: string; student_name: string;
    unrestricted_recommended_cents?: number;     // optional for legacy rows
    recommended_cents: number;
    low_cents: number; high_cents: number;
    rationale: string;
    policy_applied?: string | null;
  }>;
  total_award_range?: {
    unrestricted_recommended_cents?: number;     // optional for legacy rows
    recommended_cents?: number;
    low_cents: number;
    high_cents: number;
  };
  cost_of_living_assessment?: string | null;
  suggested_decision_note?: string;
  missing_documents?: string[];
  follow_up_questions?: string[];
}

function AiAnalysisPanel({
  applicationId, initial, analyzedAt, model,
}: {
  applicationId: string;
  initial: Record<string, unknown> | null;
  analyzedAt: string | null;
  model: string | null;
}) {
  const [analysis, setAnalysis] = useState<AnalysisShape | null>((initial as AnalysisShape | null) ?? null);
  const [stamp, setStamp] = useState<string | null>(analyzedAt);
  const [usedModel, setUsedModel] = useState<string | null>(model);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  async function run() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/school/fa-applications/${applicationId}/analyze`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.analysis) {
        setErr(j.detail || j.error || `Analysis failed (${r.status})`);
        return;
      }
      setAnalysis(j.analysis);
      setStamp(j.analyzed_at);
      setUsedModel(j.model);
      setOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!analysis && !busy && !err) {
    return (
      <div className="rounded-lg border-2 border-violet-200 bg-violet-50/40 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-violet-600 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-violet-900">AI committee analysis</h3>
            <p className="text-[11px] text-violet-800 mt-0.5 mb-2">
              Claude reads the family&rsquo;s full application + uploaded documents and produces a structured committee briefing with a recommended award range per student. Takes ~10-20 seconds. Result is cached so the committee can re-open without burning tokens.
            </p>
            <button
              type="button"
              onClick={run}
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
            >
              <Sparkles className="h-3.5 w-3.5" /> Generate AI analysis
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 flex items-center gap-3">
        <Loader2 className="h-5 w-5 text-violet-600 animate-spin" />
        <div>
          <p className="text-sm font-medium text-violet-900">Claude is reading the application…</p>
          <p className="text-[11px] text-violet-800">~10-20 seconds. Don&rsquo;t close this row — we&rsquo;ll cache the result when it returns.</p>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-rose-700 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-rose-900">Analysis failed</p>
          <p className="text-[11px] text-rose-800 mt-0.5">{err}</p>
          <button type="button" onClick={run} className="mt-2 text-[11px] text-rose-700 hover:underline font-medium">Try again</button>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const snap = analysis.financial_snapshot ?? {};
  const total = analysis.total_award_range;

  return (
    <div className="rounded-lg border-2 border-violet-200 bg-gradient-to-b from-violet-50/40 to-white overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-violet-100/60 border-b border-violet-200">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-700" />
          <h3 className="text-sm font-semibold text-violet-900">AI committee analysis</h3>
          {stamp ? <span className="text-[10px] text-violet-700">· {new Date(stamp).toLocaleString()}{usedModel ? ` · ${usedModel}` : ''}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={run} className="text-[11px] text-violet-700 hover:underline font-medium inline-flex items-center gap-0.5">
            <Sparkles className="h-3 w-3" /> Regenerate
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-violet-700">
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </header>
      {open ? (
        <div className="p-4 space-y-4 text-sm">
          {/* Executive summary */}
          {analysis.executive_summary ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-violet-700 font-bold">Executive summary</div>
              <p className="mt-1 text-slate-800 leading-relaxed">{analysis.executive_summary}</p>
            </div>
          ) : null}

          {/* Financial snapshot — KV grid */}
          <div className="rounded-md border border-violet-100 bg-white p-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <SnapStat label="Annual income"        v={fmtCents(snap.annual_income_cents)} />
            <SnapStat label="Annual expenses"      v={fmtCents(snap.annual_expenses_cents)} />
            <SnapStat label="Discretionary capacity" v={fmtCents(snap.discretionary_capacity_cents)} highlightNegative={true} cents={snap.discretionary_capacity_cents ?? null} />
            <SnapStat label="Savings runway"       v={snap.savings_runway_months != null ? `${snap.savings_runway_months.toFixed(1)} mo` : EMDASH} />
            <SnapStat label="Debt burden"          v={snap.debt_burden_label ?? EMDASH} pillTone={snap.debt_burden_label} />
            <SnapStat label="Housing burden"       v={snap.housing_burden_label ?? EMDASH} pillTone={snap.housing_burden_label} />
          </div>

          {/* Demonstrated need */}
          {analysis.demonstrated_need_assessment ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-violet-700 font-bold">Demonstrated need</div>
              <p className="mt-1 text-slate-800">{analysis.demonstrated_need_assessment}</p>
            </div>
          ) : null}

          {/* Positives + concerns side by side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <SignalList tone="positive" title="Positives" items={analysis.positives ?? []} />
            <SignalList tone="concern"  title="Concerns / yellow flags" items={analysis.concerns ?? []} />
          </div>

          {/* Per-student award recommendation — Claude's specific number, plus the range */}
          {(analysis.recommended_awards ?? []).length > 0 ? (() => {
            const familyCapped =
              total?.unrestricted_recommended_cents != null
              && total?.recommended_cents != null
              && total.unrestricted_recommended_cents > total.recommended_cents;
            return (
            <div className="rounded-md border-2 border-emerald-300 bg-emerald-50/40 p-3 space-y-2">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div className="text-[10px] uppercase tracking-wide text-emerald-800 font-bold">Recommended award</div>
                {total ? (
                  <div className="text-right">
                    {familyCapped ? (
                      <div className="text-[11px] text-slate-500 tabular-nums leading-tight">
                        Unrestricted: <span className="line-through">{fmtCents(total.unrestricted_recommended_cents ?? null)}</span>
                      </div>
                    ) : null}
                    <div className="text-lg font-bold text-emerald-900 tabular-nums leading-tight">
                      Family total: {fmtCents(total.recommended_cents ?? null)}
                    </div>
                    <div className="text-[10px] text-emerald-700 tabular-nums">
                      Range {fmtCents(total.low_cents)} – {fmtCents(total.high_cents)}
                    </div>
                    {familyCapped ? (
                      <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-[10px] font-semibold border border-amber-300">
                        Capped by school policy
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <ul className="divide-y divide-emerald-200">
                {(analysis.recommended_awards ?? []).map((rec) => {
                  const studentCapped =
                    rec.unrestricted_recommended_cents != null
                    && rec.unrestricted_recommended_cents > rec.recommended_cents;
                  return (
                  <li key={rec.student_id} className="py-2.5">
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <div className="font-medium text-emerald-900">{rec.student_name}</div>
                      <div className="text-right">
                        {studentCapped ? (
                          <div className="text-[11px] text-slate-500 tabular-nums leading-tight">
                            Unrestricted: <span className="line-through">{fmtCents(rec.unrestricted_recommended_cents ?? null)}</span>
                          </div>
                        ) : null}
                        <div className="text-base font-bold text-emerald-900 tabular-nums leading-tight">
                          {fmtCents(rec.recommended_cents)}
                        </div>
                        <div className="text-[10px] text-emerald-700 tabular-nums">
                          Range {fmtCents(rec.low_cents)} – {fmtCents(rec.high_cents)}
                        </div>
                      </div>
                    </div>
                    <p className="text-[12px] text-slate-700 mt-1">{rec.rationale}</p>
                    {rec.policy_applied ? (
                      <p className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                        <span className="font-semibold">Policy cap:</span> {rec.policy_applied}
                      </p>
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            </div>
            );
          })() : null}

          {/* Cost-of-living read */}
          {analysis.cost_of_living_assessment ? (
            <div className="rounded-md border border-sky-200 bg-sky-50/50 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-sky-800 font-bold">Cost-of-living assessment</div>
              <p className="mt-1 text-[12.5px] text-slate-800">{analysis.cost_of_living_assessment}</p>
            </div>
          ) : null}

          {/* Suggested decision note draft */}
          {analysis.suggested_decision_note ? (
            <div className="rounded-md border border-slate-200 bg-white p-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-600 font-bold">Suggested decision note (draft)</div>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(analysis.suggested_decision_note ?? '')}
                  className="text-[10px] text-blue-700 hover:underline"
                >
                  Copy
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-800 whitespace-pre-wrap italic">{analysis.suggested_decision_note}</p>
            </div>
          ) : null}

          {/* Missing docs + follow-up questions */}
          {((analysis.missing_documents ?? []).length > 0 || (analysis.follow_up_questions ?? []).length > 0) ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(analysis.missing_documents ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-amber-800 font-bold">Missing documents</div>
                  <ul className="mt-1 text-xs text-amber-900 list-disc pl-4">
                    {(analysis.missing_documents ?? []).map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              ) : null}
              {(analysis.follow_up_questions ?? []).length > 0 ? (
                <div className="rounded-md border border-blue-200 bg-blue-50/40 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-blue-800 font-bold">Follow-up questions</div>
                  <ul className="mt-1 text-xs text-blue-900 list-disc pl-4">
                    {(analysis.follow_up_questions ?? []).map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <p className="text-[10px] italic text-slate-500 border-t border-slate-100 pt-2">
            AI-generated analysis. Use as a starting point — the committee decides.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SnapStat({ label, v, pillTone, highlightNegative, cents }: { label: string; v: string; pillTone?: string; highlightNegative?: boolean; cents?: number | null }) {
  const negative = highlightNegative && cents != null && cents < 0;
  const toneBg = pillTone === 'low' ? 'bg-emerald-100 text-emerald-800'
    : pillTone === 'moderate' ? 'bg-amber-100 text-amber-800'
    : pillTone === 'high' ? 'bg-rose-100 text-rose-800'
    : '';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${negative ? 'text-rose-700' : 'text-slate-900'}`}>
        {toneBg ? <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${toneBg}`}>{v}</span> : v}
      </div>
    </div>
  );
}

function SignalList({ tone, title, items }: { tone: 'positive' | 'concern'; title: string; items: string[] }) {
  if (items.length === 0) return null;
  const bg = tone === 'positive' ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30';
  const labelColor = tone === 'positive' ? 'text-emerald-800' : 'text-amber-800';
  const Icon = tone === 'positive' ? CheckCircle2 : AlertCircle;
  const iconColor = tone === 'positive' ? 'text-emerald-700' : 'text-amber-700';
  return (
    <div className={`rounded-md border ${bg} p-3`}>
      <div className={`text-[10px] uppercase tracking-wide font-bold ${labelColor}`}>{title}</div>
      <ul className="mt-1.5 space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs text-slate-800">
            <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${iconColor}`} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtCents(c: number | null | undefined): string {
  if (c == null) return EMDASH;
  const dollars = c / 100;
  const sign = dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
