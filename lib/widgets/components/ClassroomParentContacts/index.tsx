// Parent Contact list for a single classroom. One row per student
// with EVERY parent on that student's family listed inline — name,
// relationship/role, email, phone. Click an email → mailto, click a
// phone → tel. Used by teachers for quick "who do I call about
// {student}" lookups.

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';
import { Phone, Mail, Users, AlertTriangle } from 'lucide-react';
import { PrintButton } from '../_shared/PrintButton';

export interface ClassroomParentContactsConfig {
  classroom_filter: string;
  program_filter?: string;
}

interface ParentRow {
  parent_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

interface StudentRow {
  student_id: string;
  family_id: string;
  student_first: string;
  student_last: string;
  student_preferred: string | null;
  homeroom: string | null;
  allergy: string | null;
  parents: ParentRow[];
}

// Free-text allergy field is "real" when non-blank and not no/none/etc.
function isRealAllergy(v: string | null): boolean {
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  if (!lower) return false;
  return !['no', 'none', 'n/a', 'na', 'no.', 'none.'].includes(lower);
}

interface Data {
  rows: StudentRow[];
  classroom_filter: string;
  parent_count: number;
}

async function fetcher(school: SchoolContext, config: ClassroomParentContactsConfig): Promise<Data> {
  const cf = (config.classroom_filter || '').trim();
  const pf = (config.program_filter || '').trim();
  // One row per (student, parent) pair, then group in JS — keeps the
  // SQL simple and there are only ~30 students max per classroom.
  const { rows } = await query<{
    student_id: string; family_id: string;
    student_first: string; student_last: string; student_preferred: string | null;
    homeroom: string | null; allergy: string | null;
    parent_id: string | null;
    parent_first: string | null; parent_last: string | null;
    email: string | null; phone: string | null; is_primary: boolean | null;
  }>(
    `SELECT
       s.id          AS student_id,
       s.family_id   AS family_id,
       s.first_name  AS student_first,
       s.last_name   AS student_last,
       s.preferred_name AS student_preferred,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS homeroom,
       s.metadata->>'allergy' AS allergy,
       p.id          AS parent_id,
       p.first_name  AS parent_first,
       p.last_name   AS parent_last,
       p.email,
       p.phone,
       p.is_primary
     FROM students s
     LEFT JOIN parents p
       ON p.family_id = s.family_id
      AND p.school_id = s.school_id
      AND p.status = 'active'
     WHERE s.school_id = $1 AND s.status = 'active'
       AND ($2 = '' OR COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') = $2)
       AND ($3 = '' OR s.metadata->>'program' = $3)
     ORDER BY s.last_name, s.first_name, p.is_primary DESC, p.first_name`,
    [school.schoolId, cf, pf],
  );

  // Group by student.
  const byStudent = new Map<string, StudentRow>();
  let parentCount = 0;
  for (const r of rows) {
    let bucket = byStudent.get(r.student_id);
    if (!bucket) {
      bucket = {
        student_id: r.student_id,
        family_id: r.family_id,
        student_first: r.student_first,
        student_last: r.student_last,
        student_preferred: r.student_preferred,
        homeroom: r.homeroom,
        allergy: r.allergy,
        parents: [],
      };
      byStudent.set(r.student_id, bucket);
    }
    if (r.parent_id) {
      bucket.parents.push({
        parent_id: r.parent_id,
        first_name: r.parent_first ?? '',
        last_name: r.parent_last ?? '',
        email: r.email,
        phone: r.phone,
        is_primary: !!r.is_primary,
      });
      parentCount++;
    }
  }

  return {
    rows: [...byStudent.values()],
    classroom_filter: cf || pf,
    parent_count: parentCount,
  };
}

function Component({ data }: { school: SchoolContext; config: ClassroomParentContactsConfig; data: Data }) {
  return (
    <div className="space-y-3 print:space-y-2">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2 print:text-lg">
            <Users className="h-4 w-4 text-blue-600 print:hidden" /> Parent Contacts &middot; {data.classroom_filter || 'all classrooms'}
          </h2>
          <p className="text-xs text-slate-500 print:text-[11px]">
            {data.rows.length} student{data.rows.length === 1 ? '' : 's'} · {data.parent_count} parent{data.parent_count === 1 ? '' : 's'} on file
          </p>
        </div>
        <PrintButton label="Print contacts" title="Print this classroom's parent-contact roster" />
      </div>
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Parents</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.length === 0 ? (
              <tr><td colSpan={2} className="p-6 text-center text-sm text-slate-500 italic">No students in this classroom.</td></tr>
            ) : data.rows.map((r) => (
              <tr key={r.student_id} className="hover:bg-slate-50 print:hover:bg-transparent break-inside-avoid">
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-slate-900 flex items-center gap-1.5">
                    {r.student_preferred || r.student_first} {r.student_last}
                    {isRealAllergy(r.allergy) ? <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" /> : null}
                  </div>
                  {isRealAllergy(r.allergy) ? (
                    <div className="text-[11px] text-rose-700 mt-0.5 font-medium">
                      Allergy: {r.allergy}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  {r.parents.length === 0 ? (
                    <span className="text-xs text-slate-400 italic">No parent records on file</span>
                  ) : (
                    <ul className="space-y-1.5">
                      {r.parents.map((p) => (
                        <li key={p.parent_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                          <span className="font-medium text-slate-900">
                            {p.first_name} {p.last_name}
                            {p.is_primary ? (
                              <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-800">
                                primary
                              </span>
                            ) : null}
                          </span>
                          {p.email ? (
                            <a href={`mailto:${p.email}`} className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
                              <Mail className="h-3 w-3" />{p.email}
                            </a>
                          ) : null}
                          {p.phone ? (
                            <a href={`tel:${p.phone}`} className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
                              <Phone className="h-3 w-3" />{p.phone}
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const schema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'classroom_filter', label: 'Classroom (homeroom)', placeholder: 'Classroom 4' },
  ],
};

export const ClassroomParentContacts: WidgetDefinition<ClassroomParentContactsConfig, Data> = {
  id: 'classroom_parent_contacts',
  display_name: 'Classroom Parent Contacts',
  description: 'Per-classroom list of students with all their parents\' contact info (email + phone).',
  category: 'family',
  default_config: { classroom_filter: '' },
  config_schema: schema,
  default_size: { w: 6, h: 8 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
