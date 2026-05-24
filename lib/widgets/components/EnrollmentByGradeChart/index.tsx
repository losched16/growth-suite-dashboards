import type { WidgetDefinition } from '@/lib/widgets/types';
import { enrollmentByGradeChartDefaults, enrollmentByGradeChartSchema, type EnrollmentByGradeChartConfig } from './config';
import { fetcher, type EnrollmentByGradeChartData } from './fetcher';
import { EnrollmentBars } from './Chart';

function EnrollmentByGradeChartComponent({ data }: { data: EnrollmentByGradeChartData }) {
  if (!data.academic_year) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Configure an academic year (e.g. 2026-27) for this chart.
      </div>
    );
  }
  if (data.bars.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No classrooms or enrollments for {data.academic_year}.
      </div>
    );
  }
  const pctOfTarget = data.totals.target > 0
    ? Math.round((data.totals.enrolled / data.totals.target) * 100)
    : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Enrollment by grade · {data.academic_year}</h3>
        <div className="text-xs text-gray-500">
          {data.totals.enrolled} enrolled · {data.totals.in_pipeline} in pipeline · target {data.totals.target} ({pctOfTarget}%)
        </div>
      </div>
      <div className="p-3">
        <EnrollmentBars bars={data.bars} />
      </div>
    </div>
  );
}

export const EnrollmentByGradeChart: WidgetDefinition<EnrollmentByGradeChartConfig, EnrollmentByGradeChartData> = {
  id: 'enrollment_by_grade_chart',
  display_name: 'Enrollment by Grade',
  description: 'Stacked bar chart of enrolled and in-pipeline students per grade for an academic year.',
  category: 'enrollment',
  default_config: enrollmentByGradeChartDefaults,
  config_schema: enrollmentByGradeChartSchema,
  default_size: { w: 12, h: 6 },
  Component: EnrollmentByGradeChartComponent,
  dataFetcher: fetcher,
};
