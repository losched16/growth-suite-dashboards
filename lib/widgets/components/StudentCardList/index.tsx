import type { WidgetDefinition } from '@/lib/widgets/types';
import { studentCardListDefaults, studentCardListSchema, type StudentCardListConfig } from './config';
import { fetcher, type StudentCardListData } from './fetcher';

const EMDASH = '—';
function fmtDate(s: string): string {
  if (!s) return EMDASH;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StudentCardListComponent({ data }: { data: StudentCardListData }) {
  if (!data.family_id) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No family selected. This widget is for the Family Hub detail view.
      </div>
    );
  }
  if (data.students.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
        No students on file for this family.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700">Students</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {data.students.map((s) => (
          <div key={s.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <div className="font-semibold text-gray-900">{s.name}</div>
                {s.preferred_name ? (
                  <div className="text-xs text-gray-500">prefers &ldquo;{s.preferred_name}&rdquo;</div>
                ) : null}
              </div>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
                {s.status}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <span className="text-gray-500">DOB</span>
              <span className="text-gray-800">{fmtDate(s.date_of_birth)}</span>
              <span className="text-gray-500">Gender</span>
              <span className="text-gray-800">{s.gender || EMDASH}</span>
            </div>
            {s.enrollments.length > 0 ? (
              <div className="mt-3 border-t border-gray-100 pt-2 space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Enrollments</div>
                {s.enrollments.map((e, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-gray-700">
                      {e.academic_year} · {e.classroom_name ?? '(unassigned)'}
                    </span>
                    <span className="text-gray-500">{e.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export const StudentCardList: WidgetDefinition<StudentCardListConfig, StudentCardListData> = {
  id: 'student_card_list',
  display_name: 'Student Card List',
  description: 'Per-family list of students with enrollment history. Used in Family Hub detail.',
  category: 'family',
  default_config: studentCardListDefaults,
  config_schema: studentCardListSchema,
  default_size: { w: 12, h: 6 },
  Component: StudentCardListComponent,
  dataFetcher: fetcher,
};
