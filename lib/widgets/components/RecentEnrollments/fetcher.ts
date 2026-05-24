import type { SchoolContext } from '@/lib/widgets/types';
import type { RecentEnrollmentsConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface EnrollmentItem {
  family_id: string;
  family_name: string;
  student_name: string;
  classroom_name: string | null;
  status: string;
}

export interface RecentEnrollmentsData {
  academic_year: string;
  items: EnrollmentItem[];
  total_seen: number;
  // True caveat surfaced in the UI: family-graph doesn't expose
  // enrollment-change timestamps yet, so "recent" is approximated by the
  // family-roster's natural ordering (which is by family creation desc).
  approximation_note: string;
}

export async function fetcher(
  school: SchoolContext,
  config: RecentEnrollmentsConfig
): Promise<RecentEnrollmentsData> {
  const academicYear = (config.academic_year ?? '').trim();
  if (!academicYear) {
    return {
      academic_year: '',
      items: [],
      total_seen: 0,
      approximation_note: 'Configure an academic year.',
    };
  }
  const result = await familyGraph.schools.familyRoster(school.schoolId, academicYear);
  const items: EnrollmentItem[] = [];
  for (const fam of result.families) {
    for (const s of fam.students) {
      if (!s.enrollment_status) continue;
      items.push({
        family_id: fam.family_id,
        family_name: fam.display_name ?? '',
        student_name: `${s.first_name} ${s.last_name}`.trim(),
        classroom_name: s.classroom_name ?? null,
        status: s.enrollment_status,
      });
    }
  }
  const limit = Math.max(1, Math.min(100, config.limit ?? 15));
  return {
    academic_year: result.academic_year ?? academicYear,
    items: items.slice(0, limit),
    total_seen: items.length,
    approximation_note:
      'v1: ordering approximates "newest first" from family roster. Phase 2 will sort by actual enrollment-change timestamps.',
  };
}
