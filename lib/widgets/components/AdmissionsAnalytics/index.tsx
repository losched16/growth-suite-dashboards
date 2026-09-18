// AdmissionsAnalytics — recruitment-funnel reporting for admissions teams
// and boards: funnel + stage conversion, open house, yield, time-in-stage,
// recruitment sources, applicant demographics, missing documents and
// cycle-over-cycle comparison. Read from the CRM mirror; see fetcher.ts.

import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  admissionsAnalyticsDefaults,
  admissionsAnalyticsSchema,
  type AdmissionsAnalyticsConfig,
} from './config';
import { fetcher, type AdmissionsAnalyticsData, type Breakdown, type SourceRow, type StepTiming } from './fetcher';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';
import { ghlContactUrl } from '@/lib/ghl/contact-url';

const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);
const rate = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : '—');
const fmtDays = (v: number | null) => (v == null ? '—' : `${v} day${v === 1 ? '' : 's'}`);

function Section({ title, sub, children, id }: { title: string; sub?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-lg border border-gray-200 bg-white p-4 break-inside-avoid">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {sub ? <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, color = '#111827' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-gray-600">{sub}</div> : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">{children}</p>;
}

function BarList({ b, limit = 12 }: { b: Breakdown; limit?: number }) {
  const max = Math.max(1, ...b.rows.map((r) => r.count));
  const shown = b.rows.slice(0, limit);
  return (
    <Section title={b.title} sub={`${b.with_value} of ${b.with_value + b.missing} applicants answered${b.note ? ' · ' + b.note : ''}`}>
      {shown.length === 0 ? <Empty>No answers recorded yet.</Empty> : (
        <ul className="space-y-1.5">
          {shown.map((r) => (
            <li key={r.label} className="grid grid-cols-[minmax(0,10rem)_1fr_2.5rem] items-center gap-2 text-xs">
              <span className="truncate text-gray-700" title={r.label}>{r.label}</span>
              <span className="h-2.5 rounded-full bg-gray-100">
                <span className="block h-2.5 rounded-full bg-emerald-500" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
              </span>
              <span className="text-right tabular-nums text-gray-900">{r.count}</span>
            </li>
          ))}
          {b.rows.length > limit ? (
            <li className="text-[11px] text-gray-500">+ {b.rows.length - limit} more ({b.rows.slice(limit).reduce((s, r) => s + r.count, 0)} applicants)</li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}

function SourceTable({ rows }: { rows: SourceRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Source</th>
            <th className="py-1.5 pr-3 text-right font-medium">Families</th>
            <th className="py-1.5 pr-3 text-right font-medium">Applications</th>
            <th className="py-1.5 pr-3 text-right font-medium">Apply rate</th>
            <th className="py-1.5 pr-3 text-right font-medium">Completed</th>
            <th className="py-1.5 pr-3 text-right font-medium">Offers</th>
            <th className="py-1.5 text-right font-medium">Enrolled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className="border-b border-gray-100 last:border-0">
              <td className="py-1.5 pr-3 text-gray-800">{r.source}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.units}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.applications}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">{rate(r.applications, r.units)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.completed}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{r.offers}</td>
              <td className="py-1.5 text-right tabular-nums">{r.enrolled}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimingRow({ t }: { t: StepTiming }) {
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-1.5 pr-3 text-gray-800">{t.from} → {t.to}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtDays(t.avg_days)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtDays(t.median_days)}</td>
      <td className="py-1.5 text-right tabular-nums text-gray-500">{t.n}</td>
    </tr>
  );
}

function Component({
  school,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: AdmissionsAnalyticsConfig;
  data: AdmissionsAnalyticsData;
  searchParams?: WidgetSearchParams;
}) {
  const current = searchParams ?? {};
  if (!data.ready) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-emerald-700">Admissions Analytics</h2>
        <Empty>{data.not_ready_reason}</Empty>
      </div>
    );
  }
  const f = (key: string) => data.funnel.find((x) => x.key === key);
  const maxFunnel = Math.max(1, ...data.funnel.map((x) => x.count));
  const excludedTotal = data.excluded.tagged + data.excluded.email + data.excluded.nameless;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Admissions Analytics — {data.selected_cycle} cycle</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.cycle_window ? `${data.cycle_window} · ` : ''}{data.units_in_cycle} families/applicants
            {excludedTotal ? ` · ${excludedTotal} non-family contacts left out (teachers, staff, tests)` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 print:hidden">
          <AutoSubmitForm className="flex items-center gap-2">
            <PreserveEmbedParams current={current} />
            <label className="text-xs text-gray-600" htmlFor="aa-cycle">Cycle</label>
            <select id="aa-cycle" name="cycle" defaultValue={data.selected_cycle} className="rounded-md border border-gray-300 px-2 py-1 text-xs">
              {data.cycles.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <noscript><button type="submit" className="rounded-md border px-2 py-1 text-xs">Apply</button></noscript>
          </AutoSubmitForm>
          <PrintButton />
        </div>
      </div>

      {data.notes.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 print:hidden">
          <p className="text-xs font-semibold text-amber-900">Not captured yet</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
            {data.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      ) : null}

      {/* 1 + 14 — headline numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {data.funnel.map((s) => (
          <Stat key={s.key} label={s.label} value={s.count.toLocaleString()}
            sub={s.step_rate != null ? `${fmtPct(s.step_rate)} of previous stage` : s.optional ? 'side path' : undefined} />
        ))}
      </div>

      {/* 1 + 2 — funnel and stage conversion */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Recruitment funnel" sub="Each bar is the share of all inquiries that reached the stage.">
          <ul className="space-y-2">
            {data.funnel.map((s) => (
              <li key={s.key} className="text-xs">
                <div className="flex justify-between text-gray-700">
                  <span>{s.label}{s.optional ? <span className="text-gray-400"> (side path)</span> : null}</span>
                  <span className="tabular-nums">{s.count} · {s.pct_of_top}%</span>
                </div>
                <div className="mt-1 h-3 rounded bg-gray-100">
                  <div className={`h-3 rounded ${s.optional ? 'bg-sky-400' : 'bg-emerald-500'}`} style={{ width: `${Math.max(1, (s.count / maxFunnel) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Conversion between stages" sub="Where families drop out: the share of one stage that reached the next.">
          <table className="w-full text-xs">
            <tbody>
              {data.conversions.map((c) => (
                <tr key={c.from + c.to} className="border-b border-gray-100 last:border-0">
                  <td className="py-1.5 pr-3 text-gray-800">{c.from} → {c.to}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-500">{c.to_count} of {c.from_count}</td>
                  <td className={`py-1.5 text-right font-semibold tabular-nums ${c.rate != null && c.rate < 50 ? 'text-amber-700' : 'text-gray-900'}`}>{fmtPct(c.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      {/* 3 — open house, 14 — yield */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.open_house ? (
          <Section title="Open house" sub="Registrations, attendance and how many went on to apply.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Registered" value={String(data.open_house.registered)} />
              <Stat label="Attended" value={data.open_house.attended == null ? '—' : String(data.open_house.attended)}
                sub={data.open_house.attended == null ? 'not recorded' : rate(data.open_house.attended, data.open_house.registered)} />
              <Stat label="No-shows" value={data.open_house.no_show == null ? '—' : String(data.open_house.no_show)}
                sub={data.open_house.no_show == null ? 'not recorded' : rate(data.open_house.no_show, data.open_house.registered)} />
              <Stat label="Went on to apply" value={String(data.open_house.applied_from_registered)}
                sub={`${rate(data.open_house.applied_from_registered, data.open_house.registered)} of registrants`} color="#047857" />
            </div>
            {data.open_house.by_event.length ? (
              <table className="mt-3 w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="py-1.5 pr-3 font-medium">Event</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Registered</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Attended</th>
                    <th className="py-1.5 pr-3 text-right font-medium">No-show</th>
                    <th className="py-1.5 text-right font-medium">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {data.open_house.by_event.map((e) => (
                    <tr key={e.event} className="border-b border-gray-100 last:border-0">
                      <td className="py-1.5 pr-3 text-gray-800">{e.event}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{e.registered}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{data.open_house!.attended == null ? '—' : e.attended}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{data.open_house!.no_show == null ? '—' : e.no_show}</td>
                      <td className="py-1.5 text-right tabular-nums">{e.applied}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Section>
        ) : null}
        {data.yield ? (
          <Section title="Offer acceptance and enrollment yield" sub="Of the families offered a seat, how many accepted and how many enrolled.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Offers" value={String(data.yield.offers)} />
              <Stat label="Acceptance rate" value={rate(data.yield.accepted, data.yield.offers)} sub={`${data.yield.accepted} accepted`} color="#1d4ed8" />
              <Stat label="Enrollment yield" value={rate(data.yield.enrolled, data.yield.offers)} sub={`${data.yield.enrolled} enrolled`} color="#047857" />
              <Stat label="Accepted, not enrolled" value={String(Math.max(0, data.yield.accepted - data.yield.enrolled))} sub="summer melt" color="#b45309" />
            </div>
            {f('completed') ? (
              <p className="mt-3 text-[11px] text-gray-500">
                Offer rate: {rate(data.yield.offers, f('completed')!.count)} of completed applications received an offer.
              </p>
            ) : null}
          </Section>
        ) : null}
      </div>

      {/* 12 + 13 — time in stage */}
      <Section title="Time between stages" sub="Days from one stage to the next, for families where both dates are known.">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <th className="py-1.5 pr-3 font-medium">Step</th>
              <th className="py-1.5 pr-3 text-right font-medium">Average</th>
              <th className="py-1.5 pr-3 text-right font-medium">Median</th>
              <th className="py-1.5 text-right font-medium">Families</th>
            </tr>
          </thead>
          <tbody>
            {data.timing.inquiry_to_completed ? <TimingRow t={data.timing.inquiry_to_completed} /> : null}
            {data.timing.steps.map((t) => <TimingRow key={t.from + t.to} t={t} />)}
          </tbody>
        </table>
      </Section>

      {/* 6 + 7 — sources */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="How families heard about us" sub={`Recruitment source, as the family reported it · ${data.sources.referral_captured} of ${data.units_in_cycle} recorded`}>
          {data.sources.referral_captured === 0 ? <Empty>No recruitment source recorded for this cycle yet.</Empty> : <SourceTable rows={data.sources.referral} />}
        </Section>
        <Section title="Applications by entry channel" sub="The form or calendar that first brought the family into the CRM.">
          <SourceTable rows={data.sources.channel} />
        </Section>
      </div>

      {/* 4, 5, 8, 9, 10 — who is applying */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.breakdowns.map((b) => <BarList key={b.key} b={b} />)}
      </div>

      {/* 11 — missing documents */}
      {data.documents ? (
        <Section id="documents" title="Missing documents and incomplete applications"
          sub={`${data.documents.complete} of ${data.documents.applicants} applications complete`}>
          <div className="mb-3 flex flex-wrap gap-2">
            {data.documents.by_requirement.map((r) => (
              <span key={r.label} className={`rounded-full px-2.5 py-1 text-[11px] ${r.count ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
                {r.label}: {r.count} missing
              </span>
            ))}
          </div>
          {data.documents.incomplete.length === 0 ? <Empty>Every application is complete.</Empty> : (
            <details open={data.documents.incomplete.length <= 15}>
              <summary className="cursor-pointer text-xs text-gray-700">{data.documents.incomplete.length} incomplete application(s)</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="py-1.5 pr-3 font-medium">Applicant</th>
                      <th className="py-1.5 pr-3 font-medium">Parent</th>
                      <th className="py-1.5 pr-3 font-medium">Missing</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Days since applying</th>
                      <th className="py-1.5 font-medium print:hidden" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.documents.incomplete.map((r) => (
                      <tr key={r.contact_id + r.student} className="border-b border-gray-100 last:border-0 align-top">
                        <td className="py-1.5 pr-3 text-gray-900">{r.student}</td>
                        <td className="py-1.5 pr-3 text-gray-600">{r.parent}</td>
                        <td className="py-1.5 pr-3 text-amber-800">{r.missing.join(', ')}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r.days_since_application ?? '—'}</td>
                        <td className="py-1.5 print:hidden">
                          <a href={ghlContactUrl(school.locationId, r.contact_id)} target="_blank" rel="noopener noreferrer"
                            className="whitespace-nowrap text-[11px] text-gray-500 hover:text-emerald-700 hover:underline">Open in Growth Suite ↗</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </Section>
      ) : null}

      {/* 15 — cycle over cycle */}
      <Section title="Compared with prior cycles"
        sub="Counts per admissions cycle. “Reported” rows are totals the school supplied for years before the CRM.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                <th className="py-1.5 pr-3 font-medium">Cycle</th>
                {data.yoy.milestones.map((m) => <th key={m.key} className="py-1.5 pr-3 text-right font-medium">{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.yoy.rows.map((r) => (
                <tr key={r.cycle} className={`border-b border-gray-100 last:border-0 ${r.cycle === data.selected_cycle ? 'bg-emerald-50/50 font-medium' : ''}`}>
                  <td className="py-1.5 pr-3 text-gray-800">{r.cycle}{r.source === 'reported' ? <span className="text-gray-400"> (reported)</span> : null}</td>
                  {data.yoy.milestones.map((m) => (
                    <td key={m.key} className="py-1.5 pr-3 text-right tabular-nums">{r.counts[m.key] ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

export const AdmissionsAnalytics: WidgetDefinition<AdmissionsAnalyticsConfig, AdmissionsAnalyticsData> = {
  id: 'admissions_analytics',
  display_name: 'Admissions Analytics',
  description: 'Recruitment funnel, stage conversion, open house, yield, sources, applicant demographics, missing documents and cycle-over-cycle comparison.',
  category: 'admissions',
  default_config: admissionsAnalyticsDefaults,
  config_schema: admissionsAnalyticsSchema,
  default_size: { w: 12, h: 24 },
  Component,
  dataFetcher: (school, config, searchParams) => fetcher(school, config, searchParams),
  searchParamsAffectFetch: true,
};
