import type { SchoolContext } from '@/lib/widgets/types';
import type { EnrollmentTargetsTableConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface ClassroomTargetRow {
  classroom_id: string | null;
  name: string;
  grade_level: string | null;
  target: number;
  capacity: number | null;
  enrolled: number;
  in_pipeline: number;
  by_status: Record<string, number>;
  pct_of_target: number;     // 0-100+
}

export interface EnrollmentTargetsTableData {
  academic_year: string;
  rows: ClassroomTargetRow[];
  totals: { target: number; enrolled: number; in_pipeline: number };
  mode: string;
}

const PIPELINE_STATUSES = ['inquiry', 'tour_scheduled', 'application_submitted', 'accepted', 'waitlisted'];

export async function fetcher(
  school: SchoolContext,
  config: EnrollmentTargetsTableConfig
): Promise<EnrollmentTargetsTableData> {
  const academicYear = (config.academic_year ?? '').trim();
  if (!academicYear) {
    return { academic_year: '', rows: [], totals: { target: 0, enrolled: 0, in_pipeline: 0 }, mode: config.mode };
  }
  const summary = await familyGraph.schools.admissionsSummary(school.schoolId, academicYear);

  const rows: ClassroomTargetRow[] = summary.classrooms.map((c) => {
    const enrolled = c.by_status['enrolled'] ?? 0;
    const inPipeline = PIPELINE_STATUSES.reduce((a, s) => a + (c.by_status[s] ?? 0), 0);
    const target = c.target_seats ?? 0;
    return {
      classroom_id: c.classroom_id,
      name: c.name,
      grade_level: c.grade_level,
      target,
      capacity: c.capacity,
      enrolled,
      in_pipeline: inPipeline,
      by_status: c.by_status,
      pct_of_target: target > 0 ? Math.round((enrolled / target) * 100) : 0,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      target: acc.target + r.target,
      enrolled: acc.enrolled + r.enrolled,
      in_pipeline: acc.in_pipeline + r.in_pipeline,
    }),
    { target: 0, enrolled: 0, in_pipeline: 0 }
  );

  return { academic_year: summary.academic_year, rows, totals, mode: config.mode };
}
