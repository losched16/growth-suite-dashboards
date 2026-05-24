// Per-dashboard widget editor:
//   - List each widget with its config form (pretty for known widgets,
//     JSON textarea fallback for others)
//   - "Remove" each widget
//   - "Add widget" picker at the bottom
//   - "Delete dashboard" affordance with typed-DELETE confirmation
//   - Preview link

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { listWidgets } from '@/lib/widgets/registry';
import {
  AVAILABLE_FILTERS as EH_FILTERS,
  AVAILABLE_COLUMNS as EH_COLUMNS,
  type EnrollmentHubConfig,
  type FilterKey as EHFilterKey,
  type ColumnKey as EHColumnKey,
} from '@/lib/widgets/components/EnrollmentHubTable/config';
import {
  AVAILABLE_TABS as RH_TABS,
  type RostersHubConfig,
  type TabKey as RHTabKey,
} from '@/lib/widgets/components/RostersHub/config';
import type {
  DocumentTrackerConfig,
} from '@/lib/widgets/components/DocumentTracker/config';
import type {
  FinanceDashboardConfig,
  ProgramGroup,
} from '@/lib/widgets/components/FinanceDashboard/config';
import type { WidgetInstance } from '@/lib/widgets/types';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; dashboardId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface DashboardRow {
  id: string;
  school_id: string;
  dashboard_slug: string;
  display_name: string;
  layout: WidgetInstance[];
}

interface SchoolRow {
  ghl_location_id: string;
  name: string;
}

export default async function DashboardConfigPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { schoolId, dashboardId } = await params;
  const { msg, err } = await searchParams;

  const { rows } = await query<DashboardRow>(
    `SELECT id, school_id, dashboard_slug, display_name, layout
     FROM school_dashboards WHERE id = $1 AND school_id = $2`,
    [dashboardId, schoolId],
  );
  if (rows.length === 0) notFound();
  const d = rows[0];

  const { rows: schoolRows } = await query<SchoolRow>(
    `SELECT ghl_location_id, name FROM schools WHERE id = $1`,
    [schoolId],
  );
  const school = schoolRows[0];

  const allWidgets = listWidgets();

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-4xl space-y-5">
        <div className="flex items-baseline justify-between">
          <div>
            <Link href={`/admin/${schoolId}`} className="text-xs text-zinc-500 hover:text-zinc-700">
              ← Back to school
            </Link>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-900">{d.display_name}</h1>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {d.dashboard_slug} · {d.layout.length} widget{d.layout.length === 1 ? '' : 's'}
            </p>
          </div>
          {school ? (
            <Link
              href={`/school/${school.ghl_location_id}/${d.dashboard_slug}`}
              target="_blank"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
            >
              Preview ↗
            </Link>
          ) : null}
        </div>

        {msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
        ) : null}
        {err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
        ) : null}

        {d.layout.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            No widgets in this dashboard&apos;s layout yet — pick one from the &quot;Add widget&quot; section below.
          </div>
        ) : null}

        {d.layout.map((instance, idx) => (
          <WidgetEditor
            key={instance.instance_id}
            instance={instance}
            index={idx}
            schoolId={schoolId}
            dashboardId={dashboardId}
          />
        ))}

        {/* Add widget picker */}
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-emerald-900">+ Add widget</h2>
          <form
            action={`/api/admin/schools/${schoolId}/dashboards/${dashboardId}/widgets/add`}
            method="POST"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <select
              name="widget_id"
              required
              defaultValue=""
              className="flex-1 min-w-[16rem] rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="" disabled>— pick a widget —</option>
              {allWidgets
                .slice()
                .sort((a, b) => a.display_name.localeCompare(b.display_name))
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.display_name} ({w.category})
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Add to layout
            </button>
            <p className="basis-full mt-1 text-[11px] text-zinc-500">
              The new widget appears with its default config. Edit it inline above, then save.
            </p>
          </form>
        </section>

        {/* Delete dashboard */}
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-red-900">Danger zone</h2>
          <form
            action={`/api/admin/schools/${schoolId}/dashboards/${dashboardId}/delete`}
            method="POST"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="text-xs text-red-900">
              Type <code className="font-mono">DELETE</code> to remove this dashboard permanently:
            </span>
            <input
              type="text"
              name="confirm"
              placeholder="DELETE"
              className="rounded border border-red-300 bg-white px-2 py-1 text-xs font-mono w-24"
            />
            <button
              type="submit"
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Delete dashboard
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function WidgetEditor({
  instance,
  index,
  schoolId,
  dashboardId,
}: {
  instance: WidgetInstance;
  index: number;
  schoolId: string;
  dashboardId: string;
}) {
  const configAction = `/api/admin/schools/${schoolId}/dashboards/${dashboardId}/widgets/${instance.instance_id}/config`;
  const removeAction = `/api/admin/schools/${schoolId}/dashboards/${dashboardId}/widgets/${instance.instance_id}/remove`;

  return (
    <section className="rounded-xl border border-black/10 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          {index + 1}. {widgetTitle(instance.widget_id)}
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-zinc-500">{instance.instance_id.slice(0, 8)}</span>
          <form action={removeAction} method="POST">
            <button
              type="submit"
              className="rounded border border-red-200 bg-white px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
            >
              remove
            </button>
          </form>
        </div>
      </div>
      <ConfigForm instance={instance} formAction={configAction} />
    </section>
  );
}

function widgetTitle(widgetId: string): string {
  return WIDGET_TITLES[widgetId] ?? widgetId;
}

const WIDGET_TITLES: Record<string, string> = {
  enrollment_hub_table: 'Enrollment Hub (rich)',
  family_hub_table: 'Family Hub (rich)',
  student_roster_rich: 'Student Roster (rich)',
  document_tracker: 'Document Tracker',
  rosters_hub: 'Rosters Hub (13-tab)',
  finance_dashboard: 'Financial Reports',
  admissions_funnel_stages: 'Admissions Funnel',
  payment_dashboard_placeholder: 'Payment placeholder',
  marketing_dashboard_placeholder: 'Marketing placeholder',
  form_completion_grid: 'Form Completion Grid (legacy)',
  recent_form_submissions: 'Recent Form Submissions (legacy)',
  family_list_table: 'Family List Table (legacy)',
  family_detail_card: 'Family Detail Card',
  student_card_list: 'Student Card List',
  student_roster_table: 'Student Roster Table (legacy)',
  enrollment_by_grade_chart: 'Enrollment by Grade Chart',
  enrollment_targets_table: 'Enrollment Targets Table',
  recent_enrollments: 'Recent Enrollments',
  hello_world: 'Hello World',
};

function ConfigForm({ instance, formAction }: { instance: WidgetInstance; formAction: string }) {
  switch (instance.widget_id) {
    case 'enrollment_hub_table':
      return <EnrollmentHubForm config={instance.config as EnrollmentHubConfig} formAction={formAction} />;
    case 'rosters_hub':
      return <RostersHubForm config={instance.config as RostersHubConfig} formAction={formAction} />;
    case 'document_tracker':
      return <DocumentTrackerForm config={instance.config as DocumentTrackerConfig} formAction={formAction} />;
    case 'finance_dashboard':
      return <FinanceForm config={instance.config as FinanceDashboardConfig} formAction={formAction} />;
    default:
      return <JsonForm instance={instance} formAction={formAction} />;
  }
}

function JsonForm({ instance, formAction }: { instance: WidgetInstance; formAction: string }) {
  return (
    <form action={formAction} method="POST" className="space-y-2">
      <textarea
        name="config_json"
        defaultValue={JSON.stringify(instance.config, null, 2)}
        rows={8}
        spellCheck={false}
        className="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] focus:border-zinc-500 focus:bg-white focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
      >
        Save config
      </button>
    </form>
  );
}

function EnrollmentHubForm({ config, formAction }: { config: EnrollmentHubConfig; formAction: string }) {
  const shownFilters = new Set<EHFilterKey>(config.shown_filters ?? []);
  const shownColumns = new Set<EHColumnKey>(config.shown_columns ?? []);
  return (
    <form action={formAction} method="POST" className="space-y-4 text-sm">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">Header settings</h3>
          <label className="block">
            Academic year:{' '}
            <input type="text" name="academic_year" defaultValue={config.academic_year ?? ''} placeholder="2026-27"
              className="w-32 rounded border border-zinc-300 px-2 py-1 text-sm font-mono" />
          </label>
          <label className="mt-2 block">
            Drilldown dashboard:{' '}
            <input type="text" name="drilldown_dashboard_slug" defaultValue={config.drilldown_dashboard_slug ?? 'family-hub'}
              className="w-36 rounded border border-zinc-300 px-2 py-1 text-sm font-mono" />
          </label>
          <label className="mt-2 flex items-center gap-1.5">
            <input type="checkbox" name="show_stat_cards" defaultChecked={config.show_stat_cards !== false} /> Show stat cards
          </label>
          <label className="mt-1 flex items-center gap-1.5">
            <input type="checkbox" name="show_breakdowns" defaultChecked={config.show_breakdowns !== false} /> Show breakdowns
          </label>
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">Filters shown</h3>
          <div className="space-y-1">
            {EH_FILTERS.map((f) => (
              <label key={f.key} className="flex items-center gap-1.5">
                <input type="checkbox" name="shown_filters" value={f.key} defaultChecked={shownFilters.has(f.key)} />
                {f.label}
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">Columns shown</h3>
          <div className="space-y-1">
            {EH_COLUMNS.map((c) => (
              <label key={c.key} className="flex items-center gap-1.5">
                <input type="checkbox" name="shown_columns" value={c.key} defaultChecked={shownColumns.has(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
        </div>
      </div>
      <SaveButton />
    </form>
  );
}

function RostersHubForm({ config, formAction }: { config: RostersHubConfig; formAction: string }) {
  const shown = new Set<RHTabKey>(config.shown_tabs ?? []);
  return (
    <form action={formAction} method="POST" className="space-y-3 text-sm">
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700">Tabs shown</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-y-1 gap-x-3">
          {RH_TABS.map((t) => (
            <label key={t.key} className="flex items-center gap-1.5">
              <input type="checkbox" name="shown_tabs" value={t.key} defaultChecked={shown.has(t.key)} />
              {t.label}
            </label>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <label>Default tab:
          <select name="default_tab" defaultValue={config.default_tab ?? 'school_year'} className="ml-1 rounded border border-zinc-300 px-2 py-1 text-sm">
            {RH_TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label>Drilldown dashboard:
          <input type="text" name="drilldown_dashboard_slug" defaultValue={config.drilldown_dashboard_slug ?? 'family-hub'} className="ml-1 rounded border border-zinc-300 px-2 py-1 text-sm font-mono w-32" />
        </label>
      </div>
      <SaveButton />
    </form>
  );
}

function DocumentTrackerForm({ config, formAction }: { config: DocumentTrackerConfig; formAction: string }) {
  return (
    <form action={formAction} method="POST" className="space-y-3 text-sm">
      <p className="text-[11px] text-zinc-500">
        Forms shown come from <code>school_forms</code> — manage them on the school admin page under &quot;Parent portal → Forms parents see&quot;.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          Auto-refresh interval (ms, 0 = off):
          <input type="number" name="auto_refresh_ms" defaultValue={config.auto_refresh_ms ?? 60000} min={0} max={600000}
            className="ml-1 rounded border border-zinc-300 px-2 py-1 text-sm w-24" />
        </label>
        <label className="block">
          Drilldown dashboard:
          <input type="text" name="drilldown_dashboard_slug" defaultValue={config.drilldown_dashboard_slug ?? 'family-hub'}
            className="ml-1 rounded border border-zinc-300 px-2 py-1 text-sm font-mono w-32" />
        </label>
      </div>
      <SaveButton />
    </form>
  );
}

function FinanceForm({ config, formAction }: { config: FinanceDashboardConfig; formAction: string }) {
  return (
    <form action={formAction} method="POST" className="space-y-3 text-sm">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" name="show_actual_payments_placeholder" defaultChecked={config.show_actual_payments_placeholder !== false} />
        Show &quot;actual payments coming soon&quot; placeholder
      </label>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" name="show_recipient_lists" defaultChecked={config.show_recipient_lists !== false} />
        Show recipient lists (Fin Aid / ESA / STO)
      </label>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-700">Program groups (JSON)</h3>
        <textarea
          name="program_groups_json"
          defaultValue={JSON.stringify(config.program_groups ?? [], null, 2)}
          rows={8}
          spellCheck={false}
          className="w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] focus:border-zinc-500 focus:bg-white focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          Array of {`{ label, match_patterns: [strings] }`} — each pattern is a case-insensitive
          substring match against a student&apos;s <code>program</code> field. First match wins;
          unmatched programs bucket under &quot;Other&quot;.
        </p>
      </div>
      <SaveButton />
    </form>
  );
}

function SaveButton() {
  return (
    <button
      type="submit"
      className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
    >
      Save widget config
    </button>
  );
}

void FinanceForm; void RostersHubForm; void DocumentTrackerForm;
type _ProgramGroup = ProgramGroup; void ({} as _ProgramGroup);
