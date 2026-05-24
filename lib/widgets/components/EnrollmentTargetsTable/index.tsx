import type { WidgetDefinition } from '@/lib/widgets/types';
import { enrollmentTargetsTableDefaults, enrollmentTargetsTableSchema, type EnrollmentTargetsTableConfig } from './config';
import { fetcher, type EnrollmentTargetsTableData } from './fetcher';

const FUNNEL_COLUMNS = ['inquiry', 'tour_scheduled', 'application_submitted', 'accepted', 'enrolled', 'waitlisted', 'declined'] as const;

function progressColor(pct: number): string {
  if (pct >= 100) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-emerald-400';
  if (pct >= 40) return 'bg-amber-400';
  return 'bg-rose-400';
}

function EnrollmentTargetsTableComponent({ data }: { data: EnrollmentTargetsTableData }) {
  if (!data.academic_year) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Configure an academic year (e.g. 2026-27) for this table.
      </div>
    );
  }
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No classrooms configured for {data.academic_year}.
      </div>
    );
  }

  const isAdmissions = data.mode === 'admissions';

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          {isAdmissions ? 'Admissions funnel by classroom' : 'Enrollment vs target'} · {data.academic_year}
        </h3>
        <div className="text-xs text-gray-500">
          {data.totals.enrolled}/{data.totals.target} enrolled · {data.totals.in_pipeline} in pipeline
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Classroom</th>
              {!isAdmissions ? (
                <>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">Target</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">Enrolled</th>
                  <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">In pipeline</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700 min-w-[140px]">Progress</th>
                </>
              ) : (
                FUNNEL_COLUMNS.map((s) => (
                  <th key={s} className="text-center px-2 py-2 text-[11px] font-semibold text-gray-700 capitalize">
                    {s.replace(/_/g, ' ')}
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.classroom_id ?? r.name} className="border-b border-gray-100">
                <td className="px-3 py-2 font-medium text-gray-900">
                  {r.name}
                  {r.grade_level ? <span className="ml-1 text-xs text-gray-500">({r.grade_level})</span> : null}
                </td>
                {!isAdmissions ? (
                  <>
                    <td className="text-center px-3 py-2 text-gray-700">{r.target}</td>
                    <td className="text-center px-3 py-2 font-semibold text-gray-900">{r.enrolled}</td>
                    <td className="text-center px-3 py-2 text-amber-700">{r.in_pipeline}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
                          <div className={`h-2 ${progressColor(r.pct_of_target)}`} style={{ width: `${Math.min(100, r.pct_of_target)}%` }} />
                        </div>
                        <span className="text-[11px] text-gray-600 w-10 text-right">{r.pct_of_target}%</span>
                      </div>
                    </td>
                  </>
                ) : (
                  FUNNEL_COLUMNS.map((s) => (
                    <td key={s} className="text-center px-2 py-2 text-gray-700">
                      {r.by_status[s] ?? <span className="text-gray-300">—</span>}
                    </td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const EnrollmentTargetsTable: WidgetDefinition<EnrollmentTargetsTableConfig, EnrollmentTargetsTableData> = {
  id: 'enrollment_targets_table',
  display_name: 'Enrollment Targets Table',
  description: 'Classrooms vs targets with enrollment, pipeline, and progress bars. Mode toggle for admissions funnel view.',
  category: 'enrollment',
  default_config: enrollmentTargetsTableDefaults,
  config_schema: enrollmentTargetsTableSchema,
  default_size: { w: 12, h: 6 },
  Component: EnrollmentTargetsTableComponent,
  dataFetcher: fetcher,
};
