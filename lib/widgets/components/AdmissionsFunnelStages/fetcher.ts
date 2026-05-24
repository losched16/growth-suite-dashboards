import type { SchoolContext } from '@/lib/widgets/types';
import type { AdmissionsFunnelStagesConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

const FUNNEL_ORDER = [
  'inquiry',
  'tour_scheduled',
  'application_submitted',
  'accepted',
  'enrolled',
] as const;

const STAGE_LABELS: Record<string, string> = {
  inquiry: 'Inquiry',
  tour_scheduled: 'Tour Scheduled',
  application_submitted: 'Application',
  accepted: 'Accepted',
  enrolled: 'Enrolled',
};

export interface FunnelStage {
  stage_key: string;
  label: string;
  count: number;
  pct_of_top: number; // 0..100, share of the top stage
}

export interface AdmissionsFunnelStagesData {
  academic_year: string;
  grade_filter: string;
  stages: FunnelStage[];
  totals: {
    sum_above_enrolled: number;
    enrolled: number;
  };
}

export async function fetcher(
  school: SchoolContext,
  config: AdmissionsFunnelStagesConfig
): Promise<AdmissionsFunnelStagesData> {
  const academicYear = (config.academic_year ?? '').trim();
  if (!academicYear) {
    return {
      academic_year: '',
      grade_filter: '',
      stages: [],
      totals: { sum_above_enrolled: 0, enrolled: 0 },
    };
  }
  const summary = await familyGraph.schools.admissionsSummary(school.schoolId, academicYear);

  const gradeFilter = (config.grade_level ?? '').trim().toLowerCase();
  const classrooms = gradeFilter
    ? summary.classrooms.filter((c) => (c.grade_level ?? '').toLowerCase() === gradeFilter)
    : summary.classrooms;

  // Sum each stage across all selected classrooms.
  const counts: Record<string, number> = {};
  for (const c of classrooms) {
    for (const stage of FUNNEL_ORDER) {
      counts[stage] = (counts[stage] ?? 0) + (c.by_status[stage] ?? 0);
    }
  }

  const top = counts[FUNNEL_ORDER[0]] || 0;
  const stages: FunnelStage[] = FUNNEL_ORDER.map((stage) => ({
    stage_key: stage,
    label: STAGE_LABELS[stage] ?? stage,
    count: counts[stage] ?? 0,
    pct_of_top: top > 0 ? Math.round(((counts[stage] ?? 0) / top) * 100) : 0,
  }));

  const sumAbove = FUNNEL_ORDER.slice(0, -1).reduce((a, s) => a + (counts[s] ?? 0), 0);
  return {
    academic_year: summary.academic_year,
    grade_filter: gradeFilter,
    stages,
    totals: { sum_above_enrolled: sumAbove, enrolled: counts['enrolled'] ?? 0 },
  };
}
