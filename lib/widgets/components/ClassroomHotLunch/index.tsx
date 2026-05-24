// Hot Lunch list for a single classroom. Renders one row per student
// showing their organic_lunch selection from student.metadata. Read-only
// (operators update lunch selection in GHL or via the enrollment form).

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';
import { Soup, Leaf, Drumstick, Salad, MinusCircle } from 'lucide-react';

export interface ClassroomHotLunchConfig {
  classroom_filter: string;
  // Optional program scope (Upper El, MYHS). Used when a classroom
  // filter doesn't fit because the teacher group spans multiple
  // classrooms.
  program_filter?: string;
}

interface Row {
  student_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  homeroom: string | null;
  organic_lunch: string | null;
  summer_lunch: string | null;
  summer_lunch_restrictions: string | null;
}

interface Data {
  rows: Row[];
  classroom_filter: string;
  declined_count: number;
  enrolled_count: number;
}

async function fetcher(school: SchoolContext, config: ClassroomHotLunchConfig): Promise<Data> {
  const cf = (config.classroom_filter || '').trim();
  const pf = (config.program_filter || '').trim();
  const { rows } = await query<Row>(
    `SELECT
       s.id AS student_id,
       s.first_name, s.last_name, s.preferred_name,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS homeroom,
       s.metadata->>'organic_lunch'             AS organic_lunch,
       s.metadata->>'summer_lunch'              AS summer_lunch,
       s.metadata->>'summer_lunch_restrictions' AS summer_lunch_restrictions
     FROM students s
     WHERE s.school_id = $1 AND s.status = 'active'
       AND ($2 = '' OR COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') = $2)
       AND ($3 = '' OR s.metadata->>'program' = $3)
     ORDER BY s.last_name, s.first_name`,
    [school.schoolId, cf, pf],
  );

  let declined = 0, enrolled = 0;
  for (const r of rows) {
    const v = (r.organic_lunch ?? '').toLowerCase();
    if (v.includes('decline')) declined++;
    else if (v) enrolled++;
  }
  return {
    rows,
    classroom_filter: cf || pf,   // header label: whichever scope is set
    declined_count: declined,
    enrolled_count: enrolled,
  };
}

function lunchIcon(v: string | null) {
  if (!v) return <MinusCircle className="h-4 w-4 text-slate-300" />;
  const lower = v.toLowerCase();
  if (lower.includes('decline')) return <MinusCircle className="h-4 w-4 text-slate-400" />;
  if (lower.includes('vegan'))   return <Leaf className="h-4 w-4 text-emerald-600" />;
  if (lower.includes('vegetarian')) return <Salad className="h-4 w-4 text-emerald-600" />;
  if (lower.includes('nonveg'))  return <Drumstick className="h-4 w-4 text-amber-700" />;
  return <Soup className="h-4 w-4 text-orange-600" />;
}

function Component({ data }: { school: SchoolContext; config: ClassroomHotLunchConfig; data: Data }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Soup className="h-4 w-4 text-orange-600" /> Hot Lunch
          </h2>
          <p className="text-xs text-slate-500">
            {data.classroom_filter || 'all classrooms'} · {data.rows.length} student{data.rows.length === 1 ? '' : 's'} · {data.enrolled_count} enrolled · {data.declined_count} declined
          </p>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium w-8"></th>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Lunch selection</th>
              <th className="px-3 py-2 font-medium">Restrictions / notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.length === 0 ? (
              <tr><td colSpan={4} className="p-6 text-center text-sm text-slate-500 italic">No students in this classroom.</td></tr>
            ) : data.rows.map((r) => (
              <tr key={r.student_id} className="hover:bg-slate-50">
                <td className="px-3 py-2 align-top">{lunchIcon(r.organic_lunch)}</td>
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-slate-900">
                    {r.preferred_name || r.first_name} {r.last_name}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-slate-800">
                  {r.organic_lunch || <span className="text-slate-400 italic">not set</span>}
                </td>
                <td className="px-3 py-2 align-top text-xs text-slate-600">
                  {r.summer_lunch_restrictions || <span className="text-slate-300">—</span>}
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

export const ClassroomHotLunch: WidgetDefinition<ClassroomHotLunchConfig, Data> = {
  id: 'classroom_hot_lunch',
  display_name: 'Classroom Hot Lunch',
  description: 'List of students in a classroom with their organic lunch selection.',
  category: 'student',
  default_config: { classroom_filter: '' },
  config_schema: schema,
  default_size: { w: 6, h: 8 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
