import type { WidgetDefinition } from '@/lib/widgets/types';
import { admissionsFunnelStagesDefaults, admissionsFunnelStagesSchema, type AdmissionsFunnelStagesConfig } from './config';
import { fetcher, type AdmissionsFunnelStagesData } from './fetcher';
import { FunnelView } from './Funnel';

function AdmissionsFunnelStagesComponent({ data }: { data: AdmissionsFunnelStagesData }) {
  if (!data.academic_year) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Configure an academic year (e.g. 2026-27) for the admissions funnel.
      </div>
    );
  }
  if (data.stages.every((s) => s.count === 0)) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No admissions activity for {data.academic_year}{data.grade_filter ? ` · ${data.grade_filter}` : ''}.
      </div>
    );
  }

  const conversionPct =
    data.totals.sum_above_enrolled + data.totals.enrolled > 0
      ? Math.round((data.totals.enrolled / (data.totals.sum_above_enrolled + data.totals.enrolled)) * 100)
      : 0;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Admissions funnel · {data.academic_year}
          {data.grade_filter ? <span className="text-gray-500 font-normal"> · {data.grade_filter}</span> : null}
        </h3>
        <div className="text-xs text-gray-500">
          {data.totals.enrolled} enrolled / {data.totals.sum_above_enrolled} earlier-stage · {conversionPct}% top→enrolled
        </div>
      </div>
      <div className="p-3">
        <FunnelView stages={data.stages} />
      </div>
    </div>
  );
}

export const AdmissionsFunnelStages: WidgetDefinition<AdmissionsFunnelStagesConfig, AdmissionsFunnelStagesData> = {
  id: 'admissions_funnel_stages',
  display_name: 'Admissions Funnel',
  description: 'Funnel visualization of pipeline stages: Inquiry → Tour → Application → Accepted → Enrolled.',
  category: 'admissions',
  default_config: admissionsFunnelStagesDefaults,
  config_schema: admissionsFunnelStagesSchema,
  default_size: { w: 12, h: 7 },
  Component: AdmissionsFunnelStagesComponent,
  dataFetcher: fetcher,
};
