// Thin HTTP client to the family graph service. Service-to-service auth
// via INTERNAL_API_TOKEN (must match the family graph's same env var).
//
// Response shapes mirror the family graph's own endpoints — see
// growth-suite-family-graph/app/api/v1/* for the source of truth.

const BASE = process.env.FAMILY_GRAPH_URL ?? 'https://growth-suite-family-graph.vercel.app';

function authHeader(): Record<string, string> {
  const t = process.env.INTERNAL_API_TOKEN;
  if (!t) throw new Error('INTERNAL_API_TOKEN env var is required');
  return { Authorization: `Bearer ${t}`, Accept: 'application/json' };
}

async function get<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: authHeader(), cache: 'no-store' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`family-graph GET ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface FamilySummary {
  id: string;
  school_id: string;
  display_name: string | null;
  notes: string | null;
  status: string;
  parent_count: number;
  student_count: number;
  current_year_enrollment_count: number;
}

export interface ParentRow {
  id: string;
  family_id: string;
  ghl_contact_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  role: string;
  is_primary: boolean;
  status: string;
}

export interface StudentRow {
  id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  status: string;
}

export interface EnrollmentRow {
  id: string;
  student_id: string;
  classroom_id: string | null;
  classroom_name?: string | null;
  academic_year: string;
  status: string;
  enrolled_at: string | null;
  withdrawn_at: string | null;
}

export interface AdmissionsClassroom {
  classroom_id: string | null;
  name: string;
  grade_level: string | null;
  target_seats: number;
  capacity: number | null;
  by_status: Record<string, number>;
}

// ---- Operations -----------------------------------------------------------

export const familyGraph = {
  families: {
    list: (schoolId: string, status?: string) => {
      const params = new URLSearchParams({ school_id: schoolId });
      if (status) params.set('status', status);
      return get<{ families: FamilySummary[]; count: number }>(
        `/api/v1/families?${params}`
      );
    },
    get: (familyId: string) =>
      get<{
        family: FamilySummary;
        parents: ParentRow[];
        students: StudentRow[];
        enrollments: EnrollmentRow[];
        relationships: Array<Record<string, unknown>>;
      }>(`/api/v1/families/${familyId}`),
  },
  schools: {
    admissionsSummary: (schoolId: string, academicYear: string) =>
      get<{ academic_year: string; classrooms: AdmissionsClassroom[] }>(
        `/api/v1/schools/${schoolId}/admissions-summary?academic_year=${encodeURIComponent(academicYear)}`
      ),
    familyRoster: (schoolId: string, academicYear?: string) => {
      const qs = academicYear ? `?academic_year=${encodeURIComponent(academicYear)}` : '';
      return get<{
        academic_year: string | null;
        families: Array<{
          family_id: string;
          display_name: string | null;
          status: string;
          parents: ParentRow[];
          students: Array<StudentRow & {
            enrollment_status: string | null;
            classroom_id: string | null;
            classroom_name: string | null;
          }>;
        }>;
      }>(`/api/v1/schools/${schoolId}/family-roster${qs}`);
    },
  },
};
