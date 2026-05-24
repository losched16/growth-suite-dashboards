import type { SchoolContext } from '@/lib/widgets/types';
import type { StudentCardListConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface StudentCardData {
  id: string;
  name: string;
  preferred_name: string;
  date_of_birth: string;
  gender: string;
  status: string;
  enrollments: Array<{
    academic_year: string;
    classroom_name: string | null;
    status: string;
    enrolled_at: string | null;
  }>;
}

export interface StudentCardListData {
  family_id: string | null;
  family_name: string;
  students: StudentCardData[];
}

export async function fetcher(
  _school: SchoolContext,
  config: StudentCardListConfig
): Promise<StudentCardListData> {
  if (!config.family_id) {
    return { family_id: null, family_name: '', students: [] };
  }
  const detail = await familyGraph.families.get(config.family_id);

  // Group enrollments by student.
  const enrollByStudent = new Map<string, StudentCardData['enrollments']>();
  for (const e of detail.enrollments) {
    const list = enrollByStudent.get(e.student_id) ?? [];
    list.push({
      academic_year: e.academic_year,
      classroom_name: e.classroom_name ?? null,
      status: e.status,
      enrolled_at: e.enrolled_at,
    });
    enrollByStudent.set(e.student_id, list);
  }

  return {
    family_id: detail.family.id,
    family_name: detail.family.display_name ?? '',
    students: detail.students.map((s) => ({
      id: s.id,
      name: `${s.first_name} ${s.last_name}`.trim(),
      preferred_name: s.preferred_name ?? '',
      date_of_birth: s.date_of_birth ?? '',
      gender: s.gender ?? '',
      status: s.status,
      enrollments: enrollByStudent.get(s.id) ?? [],
    })),
  };
}
