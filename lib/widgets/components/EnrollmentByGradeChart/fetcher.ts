import type { SchoolContext } from '@/lib/widgets/types';
import type { EnrollmentByGradeChartConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface GradeBar {
  grade_label: string;        // classroom name (or grade level if available)
  enrolled: number;
  in_pipeline: number;        // accepted | application_submitted | tour | inquiry
  capacity: number | null;
  target: number;
}

export interface EnrollmentByGradeChartData {
  academic_year: string;
  bars: GradeBar[];
  totals: {
    enrolled: number;
    in_pipeline: number;
    target: number;
  };
}

const PIPELINE_STATUSES = new Set(['inquiry', 'tour_scheduled', 'application_submitted', 'accepted', 'waitlisted']);

export async function fetcher(
  school: SchoolContext,
  config: EnrollmentByGradeChartConfig
): Promise<EnrollmentByGradeChartData> {
  const academicYear = (config.academic_year ?? '').trim();
  if (!academicYear) {
    return { academic_year: '', bars: [], totals: { enrolled: 0, in_pipeline: 0, target: 0 } };
  }
  const summary = await familyGraph.schools.admissionsSummary(school.schoolId, academicYear);

  const bars: GradeBar[] = summary.classrooms.map((c) => {
    const enrolled = c.by_status['enrolled'] ?? 0;
    let inPipeline = 0;
    for (const [status, n] of Object.entries(c.by_status)) {
      if (PIPELINE_STATUSES.has(status)) inPipeline += n;
    }
    return {
      grade_label: c.grade_level ?? c.name,
      enrolled,
      in_pipeline: inPipeline,
      capacity: c.capacity,
      target: c.target_seats,
    };
  });

  const totals = bars.reduce(
    (acc, b) => ({
      enrolled: acc.enrolled + b.enrolled,
      in_pipeline: acc.in_pipeline + b.in_pipeline,
      target: acc.target + b.target,
    }),
    { enrolled: 0, in_pipeline: 0, target: 0 }
  );

  return { academic_year: summary.academic_year, bars, totals };
}
