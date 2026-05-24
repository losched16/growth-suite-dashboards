// Unauthorized Pickup list for a classroom. Per-student list of people
// who are NOT allowed to pick up the student. Sensitive — never shown
// to parents.
//
// Backed by student_pickup_restrictions (migration 032). Operator
// adds rows via the admin form (out of scope for v1 of this widget —
// will display an empty state with a "Add a restriction" link to the
// admin route once that route exists).

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';
import { ShieldAlert, UserX } from 'lucide-react';

export interface ClassroomPickupRestrictionsConfig {
  classroom_filter: string;
  program_filter?: string;
}

interface RestrictionRow {
  id: string;
  person_name: string;
  relationship: string | null;
  reason: string | null;
  notes: string | null;
}

interface StudentRow {
  student_id: string;
  student_first: string;
  student_last: string;
  student_preferred: string | null;
  homeroom: string | null;
  restrictions: RestrictionRow[];
}

interface Data {
  rows: StudentRow[];                // ALL students in classroom (even with no restrictions)
  students_with_restrictions: number;
  classroom_filter: string;
}

async function fetcher(school: SchoolContext, config: ClassroomPickupRestrictionsConfig): Promise<Data> {
  const cf = (config.classroom_filter || '').trim();
  const pf = (config.program_filter || '').trim();
  const { rows } = await query<{
    student_id: string;
    student_first: string; student_last: string; student_preferred: string | null;
    homeroom: string | null;
    restriction_id: string | null;
    person_name: string | null;
    relationship: string | null;
    reason: string | null;
    notes: string | null;
  }>(
    `SELECT
       s.id AS student_id,
       s.first_name  AS student_first,
       s.last_name   AS student_last,
       s.preferred_name AS student_preferred,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS homeroom,
       r.id          AS restriction_id,
       r.person_name,
       r.relationship,
       r.reason,
       r.notes
     FROM students s
     LEFT JOIN student_pickup_restrictions r
       ON r.student_id = s.id
      AND r.school_id  = s.school_id
      AND r.active = true
     WHERE s.school_id = $1 AND s.status = 'active'
       AND ($2 = '' OR COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') = $2)
       AND ($3 = '' OR s.metadata->>'program' = $3)
     ORDER BY s.last_name, s.first_name, r.created_at`,
    [school.schoolId, cf, pf],
  );

  const byStudent = new Map<string, StudentRow>();
  let withRestrictions = 0;
  for (const r of rows) {
    let bucket = byStudent.get(r.student_id);
    if (!bucket) {
      bucket = {
        student_id: r.student_id,
        student_first: r.student_first,
        student_last: r.student_last,
        student_preferred: r.student_preferred,
        homeroom: r.homeroom,
        restrictions: [],
      };
      byStudent.set(r.student_id, bucket);
    }
    if (r.restriction_id) {
      bucket.restrictions.push({
        id: r.restriction_id,
        person_name: r.person_name ?? '(unnamed)',
        relationship: r.relationship,
        reason: r.reason,
        notes: r.notes,
      });
    }
  }
  for (const s of byStudent.values()) if (s.restrictions.length > 0) withRestrictions++;

  return {
    rows: [...byStudent.values()],
    students_with_restrictions: withRestrictions,
    classroom_filter: cf || pf,
  };
}

function Component({ data }: { school: SchoolContext; config: ClassroomPickupRestrictionsConfig; data: Data }) {
  // Show only students that HAVE restrictions in the body, plus a footer
  // stat for the total students in classroom. A teacher doesn't need to
  // scroll past 30 "no restrictions" rows.
  const withRestrictions = data.rows.filter((r) => r.restrictions.length > 0);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-600" /> Unauthorized for Pickup
        </h2>
        <p className="text-xs text-slate-500">
          {data.classroom_filter || 'all classrooms'} · {data.students_with_restrictions} of {data.rows.length} student{data.rows.length === 1 ? '' : 's'} flagged
        </p>
      </div>

      {withRestrictions.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-4 text-sm text-emerald-900">
          <strong>No pickup restrictions on file for this classroom.</strong>
          <p className="text-xs mt-1 text-emerald-800">
            If a family has someone restricted from picking up their student, ask the school office to add them via the admin tools.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-rose-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-rose-50 border-b border-rose-100 text-left text-[10px] uppercase tracking-wide text-rose-900">
              <tr>
                <th className="px-3 py-2 font-medium">Student</th>
                <th className="px-3 py-2 font-medium">Person not allowed</th>
                <th className="px-3 py-2 font-medium">Relationship</th>
                <th className="px-3 py-2 font-medium">Reason / notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rose-100">
              {withRestrictions.flatMap((s) =>
                s.restrictions.map((r) => (
                  <tr key={r.id} className="hover:bg-rose-50/30">
                    <td className="px-3 py-2 align-top font-medium text-slate-900">
                      {s.student_preferred || s.student_first} {s.student_last}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-900">
                      <UserX className="inline h-3.5 w-3.5 text-rose-600 mr-1" />
                      {r.person_name}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-700 text-xs">{r.relationship || '—'}</td>
                    <td className="px-3 py-2 align-top text-slate-700 text-xs">
                      {r.reason ? <div className="font-medium">{r.reason}</div> : null}
                      {r.notes ? <div className="text-slate-500 mt-0.5">{r.notes}</div> : null}
                      {!r.reason && !r.notes ? <span className="text-slate-300">—</span> : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const schema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'classroom_filter', label: 'Classroom (homeroom)', placeholder: 'Classroom 4' },
  ],
};

export const ClassroomPickupRestrictions: WidgetDefinition<ClassroomPickupRestrictionsConfig, Data> = {
  id: 'classroom_pickup_restrictions',
  display_name: 'Classroom Pickup Restrictions',
  description: 'Per-classroom list of people barred from picking up specific students. Sensitive — operator + teacher view only.',
  category: 'student',
  default_config: { classroom_filter: '' },
  config_schema: schema,
  default_size: { w: 12, h: 6 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
