// Multi-tab Roster widget. Operator picks which tabs to show per school.
// Each tab is a pre-built filter over the school's students. URL state:
//   ?tab=<key>&q=<search>

import Link from 'next/link';
import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  AVAILABLE_TABS,
  rostersHubDefaults,
  rostersHubSchema,
  type RostersHubConfig,
  type TabKey,
} from './config';
import { fetcher, type RostersHubData, type RosterStudentRow, type FamilyMeta, TAB_PREDICATES } from './fetcher';
import { PreserveEmbedParams } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { DownloadCsvButton } from '@/components/DownloadCsvButton';

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmt(n: number): string {
  return n === 0 ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ageFrom(dob: string | null): string {
  if (!dob) return '—';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  let mos = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) mos--;
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs >= 1) return `${yrs}y ${Math.max(0, mos)}m`;
  return `${Math.max(0, mos)}m`;
}

function StudentName({ s, locationId, drilldown }: { s: RosterStudentRow; locationId: string; drilldown: string }) {
  const display = s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name;
  return (
    <div className="min-w-0">
      <Link
        href={`/school/${locationId}/${drilldown}/${s.family_id}`}
        className="font-medium text-emerald-700 hover:underline"
      >
        {display} {s.last_name}
      </Link>
      <div className="text-[11px] text-gray-500 truncate">{s.primary_parent_name}</div>
    </div>
  );
}

function TabBar({
  shown,
  current,
  counts,
  baseHref,
  searchParams,
}: {
  shown: TabKey[];
  current: TabKey;
  counts: Record<string, number>;
  baseHref: string;
  searchParams: WidgetSearchParams;
}) {
  function urlFor(k: TabKey): string {
    const p = new URLSearchParams();
    for (const [key, val] of Object.entries(searchParams)) {
      if (val && key !== 'tab' && key !== 'q') p.set(key, val);
    }
    p.set('tab', k);
    if (searchParams.q) p.set('q', searchParams.q);
    return `${baseHref}?${p.toString()}`;
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="flex flex-wrap gap-0 border-b border-gray-100">
        {shown.map((key) => {
          const def = AVAILABLE_TABS.find((t) => t.key === key);
          if (!def) return null;
          const active = key === current;
          return (
            <a
              key={key}
              href={urlFor(key)}
              className={`px-3 py-2 text-xs font-medium border-r border-gray-100 last:border-r-0 transition ${
                active ? 'bg-emerald-600 text-white' : 'bg-white text-gray-700 hover:bg-emerald-50'
              }`}
            >
              {def.label}
              <span className={`ml-1.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] ${
                active ? 'bg-emerald-700/40 text-white' : 'bg-gray-100 text-gray-600'
              }`}>
                {counts[key] ?? 0}
              </span>
            </a>
          );
        })}
      </div>
      <div className="px-4 py-2 bg-gray-50 flex items-center gap-3 text-xs text-gray-600">
        <span>{AVAILABLE_TABS.find((t) => t.key === current)?.help}</span>
        <AutoSubmitForm className="ml-auto flex items-center gap-2">
          <input type="hidden" name="tab" value={current} />
          <PreserveEmbedParams current={searchParams} />
          <input
            type="search"
            name="q"
            defaultValue={searchParams.q ?? ''}
            placeholder="Search student or parent name…"
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs w-56 focus:border-emerald-600 focus:outline-none"
          />
          <noscript>
            <button type="submit" className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-800">
              Filter
            </button>
          </noscript>
        </AutoSubmitForm>
      </div>
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

function Head({ cols, rightCols }: { cols: string[]; rightCols?: number[] }) {
  return (
    <thead className="bg-gray-50 border-b border-gray-100 text-[11px] uppercase tracking-wide text-gray-500 text-left">
      <tr>{cols.map((c, i) => <th key={c} className={`px-3 py-2 font-medium ${rightCols?.includes(i) ? 'text-right' : ''}`}>{c}</th>)}</tr>
    </thead>
  );
}

function Td({ children, right, className = '' }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`px-3 py-2 align-top ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>;
}

// --- Per-tab body renderers -----------------------------------------------

function SchoolYearTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'Gender', 'DOB', 'Grade', 'Start date', 'Schedule', 'Status']} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.gender || '—'}</Td>
            <Td>{fmtDate(s.date_of_birth)}</Td>
            <Td>{s.program || '—'}</Td>
            <Td>{fmtDate(s.enrolled_at)}</Td>
            <Td>{s.schedule || '—'}</Td>
            <Td>{s.enrollment_status ? <span className="inline-block rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] uppercase tracking-wide font-medium">{s.enrollment_status.replace(/_/g, ' ')}</span> : '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function SummerTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'Program', 'Schedule', 'Classroom', 'Form received', 'Jun', 'Jul', 'Lunch']} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.summer_program || '—'}</Td>
            <Td>{s.summer_schedule || '—'}</Td>
            <Td>{s.summer_classroom || '—'}</Td>
            <Td>{fmtDate(s.summer_form_received_date)}</Td>
            <Td>{s.summer_month_june || '—'}</Td>
            <Td>{s.summer_month_july || '—'}</Td>
            <Td>{s.summer_lunch || '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function SstTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'SST Status', 'Start date', 'SST fee']} rightCols={[3]} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.sst_status || '—'}</Td>
            <Td>{fmtDate(s.sst_start_date)}</Td>
            <Td right>{fmt(s.sst_fee)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function ServiceTab({ rows, locationId, drilldown, which }: { rows: RosterStudentRow[]; locationId: string; drilldown: string; which: 1 | 2 }) {
  return (
    <Wrap>
      <Head cols={['Student', which === 1 ? 'Enrichment' : 'Sport', 'Homeroom', 'Bill']} rightCols={[3]} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{(which === 1 ? s.service_1 : s.service_2) || '—'}</Td>
            <Td>{s.homeroom || s.classroom_name || '—'}</Td>
            <Td right>{fmt(which === 1 ? s.service_1_bill : s.service_2_bill)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function HearingVisionTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'Homeroom', 'Fall', 'Spring']} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.homeroom || s.classroom_name || '—'}</Td>
            <Td>{fmtDate(s.hearing_vision_fall)}</Td>
            <Td>{fmtDate(s.hearing_vision_spring)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function EsaTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'ESA recipient', 'Amount']} rightCols={[2]} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.esa_recipient || '—'}</Td>
            <Td right>{fmt(s.esa_amount)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function StoTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'STO recipient', 'Type', 'Amount']} rightCols={[3]} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.sto_recipient || '—'}</Td>
            <Td>{s.sto_type || '—'}</Td>
            <Td right>{fmt(s.sto_amount)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function FinAidTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  const total = rows.reduce((sum, s) => sum + s.financial_aid, 0);
  return (
    <Wrap>
      <Head cols={['Student', 'Program', 'Tuition', 'Financial aid', 'Net']} rightCols={[2, 3, 4]} />
      <tbody className="divide-y divide-gray-100">
        {[...rows].sort((a, b) => b.financial_aid - a.financial_aid).map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.program ?? '—'}</Td>
            <Td right>{fmt(s.tuition_fee)}</Td>
            <Td right className="font-medium text-emerald-700">{fmt(s.financial_aid)}</Td>
            <Td right>{fmt(s.tuition_fee - s.financial_aid)}</Td>
          </tr>
        ))}
        <tr className="bg-emerald-50 text-sm font-semibold">
          <td className="px-3 py-2" colSpan={3}>Total ({rows.length} students)</td>
          <td className="px-3 py-2 text-right tabular-nums text-emerald-800">{fmt(total)}</td>
          <td />
        </tr>
      </tbody>
    </Wrap>
  );
}

function EmployeeKidsTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  return (
    <Wrap>
      <Head cols={['Student', 'Parent', 'Tuition', 'Employee discount']} rightCols={[2, 3]} />
      <tbody className="divide-y divide-gray-100">
        {rows.map((s) => (
          <tr key={s.student_id}>
            <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
            <Td>{s.primary_parent_name}</Td>
            <Td right>{fmt(s.tuition_fee)}</Td>
            <Td right className="text-emerald-700 font-medium">{fmt(s.employee_discount)}</Td>
          </tr>
        ))}
      </tbody>
    </Wrap>
  );
}

function SiblingsTab({
  families,
  students,
  locationId,
  drilldown,
}: {
  families: FamilyMeta[];
  students: RosterStudentRow[];
  locationId: string;
  drilldown: string;
}) {
  const sibFamilies = families.filter((f) => f.student_count > 1);
  return (
    <Wrap>
      <Head cols={['Family', 'Students', 'Programs', 'Total tuition', 'Sibling discount']} rightCols={[3, 4]} />
      <tbody className="divide-y divide-gray-100">
        {sibFamilies.map((fam) => {
          const famStudents = students.filter((s) => s.family_id === fam.family_id);
          const tuitionTotal = famStudents.reduce((sum, s) => sum + s.tuition_fee, 0);
          const sibDisc = famStudents.reduce((sum, s) => sum + s.sibling_discount, 0);
          return (
            <tr key={fam.family_id}>
              <Td>
                <Link
                  href={`/school/${locationId}/${drilldown}/${fam.family_id}`}
                  className="font-medium text-emerald-700 hover:underline"
                >
                  {fam.family_display_name ?? `${fam.primary_parent_name} Family`}
                </Link>
                <div className="text-[11px] text-gray-500">{fam.primary_parent_email}</div>
              </Td>
              <Td>
                <div className="space-y-0.5">
                  {famStudents.map((s) => (
                    <div key={s.student_id} className="text-xs">
                      <strong>{s.preferred_name ?? s.first_name}</strong> {s.last_name}
                      <span className="text-gray-500"> · {s.program ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </Td>
              <Td>{[...new Set(famStudents.map((s) => s.program).filter(Boolean))].join(', ')}</Td>
              <Td right>{fmt(tuitionTotal)}</Td>
              <Td right className="text-emerald-700 font-medium">{fmt(sibDisc)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Wrap>
  );
}

function ScheduleTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  const groups = new Map<string, RosterStudentRow[]>();
  for (const s of rows) {
    const k = s.schedule ?? '(no schedule)';
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }
  return (
    <div className="space-y-3">
      {[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([sched, items]) => (
        <section key={sched} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-gray-900">{sched}</h3>
            <span className="text-xs text-gray-500">{items.length} students</span>
          </div>
          <table className="w-full text-sm">
            <Head cols={['Student', 'Homeroom', 'Lead teacher', 'Status']} />
            <tbody className="divide-y divide-gray-100">
              {items.map((s) => (
                <tr key={s.student_id}>
                  <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
                  <Td>{s.homeroom || s.classroom_name || '—'}</Td>
                  <Td>{s.lead_teacher_name || '—'}</Td>
                  <Td>{s.enrollment_status || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function ReferralsTab({ rows, locationId, drilldown }: { rows: RosterStudentRow[]; locationId: string; drilldown: string }) {
  const byReferrer = new Map<string, number>();
  for (const s of rows) {
    const k = (s.referred_by ?? '').trim();
    if (k) byReferrer.set(k, (byReferrer.get(k) ?? 0) + 1);
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <Wrap>
          <Head cols={['Student', 'Referred by', 'Referral credit', 'Enrolled at']} rightCols={[2]} />
          <tbody className="divide-y divide-gray-100">
            {rows.map((s) => (
              <tr key={s.student_id}>
                <Td><StudentName s={s} locationId={locationId} drilldown={drilldown} /></Td>
                <Td>{s.referred_by}</Td>
                <Td right>{fmt(s.referral_credit)}</Td>
                <Td>{fmtDate(s.enrolled_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Wrap>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
          <h3 className="text-sm font-semibold text-gray-900">Top referrers</h3>
        </div>
        <ul className="divide-y divide-gray-100 max-h-96 overflow-y-auto text-sm">
          {[...byReferrer.entries()].sort((a, b) => b[1] - a[1]).map(([who, count]) => (
            <li key={who} className="flex items-center justify-between px-3 py-2">
              <span className="text-gray-900">{who}</span>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase text-emerald-800">
                {count} {count === 1 ? 'kid' : 'kids'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Component({
  school,
  config,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: RostersHubConfig;
  data: RostersHubData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const shown = config.shown_tabs ?? rostersHubDefaults.shown_tabs;
  const initialTab = (sp.tab as TabKey | undefined) ?? config.default_tab ?? 'school_year';
  const tab: TabKey = shown.includes(initialTab) ? initialTab : shown[0] ?? 'school_year';
  const drilldown = config.drilldown_dashboard_slug ?? 'family-hub';
  const baseHref = '';

  // Filter students by the active tab predicate
  let tabStudents: RosterStudentRow[] = [];
  if (tab !== 'siblings') {
    const pred = TAB_PREDICATES[tab];
    tabStudents = pred ? data.students.filter(pred) : data.students;
  }

  // Search filter on top of tab filter
  const q = (sp.q ?? '').trim().toLowerCase();
  if (q) {
    tabStudents = tabStudents.filter((s) => {
      const name = `${s.first_name} ${s.last_name} ${s.preferred_name ?? ''}`.toLowerCase();
      return name.includes(q) || s.primary_parent_name.toLowerCase().includes(q);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-emerald-700">Rosters</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {data.total} students across {data.families.length} families · pick a tab
          </p>
        </div>
        <DownloadCsvButton
          href={`/api/export/rosters/${school.locationId}?tab=${tab}`}
          label={`Download "${AVAILABLE_TABS.find((t) => t.key === tab)?.label ?? tab}" CSV`}
        />
      </div>

      <TabBar shown={shown} current={tab} counts={data.counts} baseHref={baseHref} searchParams={sp} />

      <div>
        {tab === 'school_year'     && <SchoolYearTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'summer'          && <SummerTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'sst'             && <SstTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'enrichment'      && <ServiceTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} which={1} />}
        {tab === 'sports'          && <ServiceTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} which={2} />}
        {tab === 'hearing_vision'  && <HearingVisionTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'esa'             && <EsaTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'sto'             && <StoTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'fin_aid'         && <FinAidTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'employee_kids'   && <EmployeeKidsTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'siblings'        && <SiblingsTab families={data.families} students={data.students} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'schedule'        && <ScheduleTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}
        {tab === 'referrals'       && <ReferralsTab rows={tabStudents} locationId={school.locationId} drilldown={drilldown} />}

        {tabStudents.length === 0 && tab !== 'siblings' ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            No students match this roster.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const RostersHub: WidgetDefinition<RostersHubConfig, RostersHubData> = {
  id: 'rosters_hub',
  display_name: 'Rosters Hub (13-tab)',
  description: 'Tabbed roster widget with per-school configurable tab set.',
  category: 'student',
  default_config: rostersHubDefaults,
  config_schema: rostersHubSchema,
  default_size: { w: 12, h: 12 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
