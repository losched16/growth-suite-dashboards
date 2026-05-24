import type { SchoolContext } from '@/lib/widgets/types';
import type { FamilyListTableConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface FamilyListRow {
  family_id: string;
  display_name: string;
  status: string;
  parent_count: number;
  student_count: number;
  current_year_enrollment_count: number;
}

export interface FamilyListTableData {
  rows: FamilyListRow[];
  totals: {
    families: number;
    students: number;
  };
  drilldown_slug: string;
}

export async function fetcher(
  school: SchoolContext,
  config: FamilyListTableConfig
): Promise<FamilyListTableData> {
  const status = config.status_filter === 'all' ? undefined : config.status_filter;
  const result = await familyGraph.families.list(school.schoolId, status);
  const rows: FamilyListRow[] = result.families.map((f) => ({
    family_id: f.id,
    display_name: f.display_name ?? '(unnamed family)',
    status: f.status,
    parent_count: f.parent_count,
    student_count: f.student_count,
    current_year_enrollment_count: f.current_year_enrollment_count,
  }));
  rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
  const totalStudents = rows.reduce((acc, r) => acc + r.student_count, 0);
  return {
    rows,
    totals: { families: rows.length, students: totalStudents },
    drilldown_slug: config.drilldown_dashboard_slug || 'family-hub',
  };
}
