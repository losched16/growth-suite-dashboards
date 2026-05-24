import type { SchoolContext } from '@/lib/widgets/types';
import type { StudentRosterTableConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface StudentRow {
  student_id: string;
  family_id: string;
  family_name: string;
  name: string;
  date_of_birth: string;
  classroom_name: string | null;
  enrollment_status: string | null;
}

export interface StudentRosterTableData {
  rows: StudentRow[];
  totals: {
    students: number;
    enrolled: number;
  };
  academic_year: string;
}

export async function fetcher(
  school: SchoolContext,
  config: StudentRosterTableConfig
): Promise<StudentRosterTableData> {
  const academicYear = (config.academic_year ?? '').trim() || undefined;
  const result = await familyGraph.schools.familyRoster(school.schoolId, academicYear);

  const rows: StudentRow[] = [];
  for (const fam of result.families) {
    for (const s of fam.students) {
      rows.push({
        student_id: s.id,
        family_id: fam.family_id,
        family_name: fam.display_name ?? '',
        name: `${s.first_name} ${s.last_name}`.trim(),
        date_of_birth: s.date_of_birth ?? '',
        classroom_name: s.classroom_name ?? null,
        enrollment_status: s.enrollment_status ?? null,
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const enrolled = rows.filter((r) => r.enrollment_status === 'enrolled').length;
  return {
    rows,
    totals: { students: rows.length, enrolled },
    academic_year: result.academic_year ?? academicYear ?? '',
  };
}
