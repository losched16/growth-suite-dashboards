import Link from 'next/link';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import { studentRosterTableDefaults, studentRosterTableSchema, type StudentRosterTableConfig } from './config';
import { fetcher, type StudentRosterTableData } from './fetcher';

const EMDASH = '—';
function fmtDate(s: string): string {
  if (!s) return EMDASH;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StudentRosterTableComponent({
  school,
  data,
}: {
  school: SchoolContext;
  data: StudentRosterTableData;
}) {
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <strong className="block mb-1">No students in the family graph yet.</strong>
        Run the intake endpoint to populate. Until then this widget renders empty.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Students</h3>
        <div className="text-xs text-gray-500">
          {data.totals.students} students · {data.totals.enrolled} enrolled
          {data.academic_year ? ` · ${data.academic_year}` : ''}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50">
          <tr>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Student</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">DOB</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Family</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Classroom</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.student_id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 font-medium text-gray-900">{r.name}</td>
              <td className="px-3 py-2 text-xs text-gray-700">{fmtDate(r.date_of_birth)}</td>
              <td className="px-3 py-2 text-xs text-gray-700">
                <Link
                  href={`/school/${school.locationId}/family-hub/${r.family_id}`}
                  className="text-emerald-700 hover:underline"
                >
                  {r.family_name || '(unnamed)'}
                </Link>
              </td>
              <td className="px-3 py-2 text-xs text-gray-700">{r.classroom_name ?? EMDASH}</td>
              <td className="px-3 py-2 text-xs text-gray-500">{r.enrollment_status ?? EMDASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const StudentRosterTable: WidgetDefinition<StudentRosterTableConfig, StudentRosterTableData> = {
  id: 'student_roster_table',
  display_name: 'Student Roster Table',
  description: 'Sortable table of all students with classroom and enrollment status.',
  category: 'student',
  default_config: studentRosterTableDefaults,
  config_schema: studentRosterTableSchema,
  default_size: { w: 12, h: 8 },
  Component: StudentRosterTableComponent,
  dataFetcher: fetcher,
};
