// Classroom Allergies & Special Needs roster — one row per student in
// the configured classroom showing food allergy + special instructions
// + lunch selection. Designed first and foremost as a PRINTABLE sheet
// teachers can post in the classroom / hand to subs.
//
// Source data flows in from:
//   - scripts/import-dgm-allergies.mjs (yearly bulk import from xlsx)
//   - MYHS OTC Medication form submissions (per-family updates)
//   - AZ State Emergency, Information & Immunization Record Card
//
// All three write to students.metadata.allergy + .special_instructions,
// which is what this widget reads. The dedicated student_health_profiles
// table is a fallback for forms-driven workflows; we union both sources
// so a record-keeping change in either surface shows up here.

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';
import { AlertTriangle, Soup, FileWarning } from 'lucide-react';
import { PrintButton } from '../_shared/PrintButton';

export interface ClassroomAllergiesConfig {
  classroom_filter: string;
  program_filter?: string;
  // When true, hide students who have no allergy AND no special
  // instructions. Default false so teachers see the full roster and
  // can confirm "yes I read every student's status."
  hide_students_without_concerns?: boolean;
}

interface Row {
  student_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  homeroom: string | null;
  allergy: string | null;
  special_instructions: string | null;
  organic_lunch: string | null;
  health_allergies: string | null;
  health_conditions: string | null;
}

interface Data {
  rows: Row[];
  classroom_filter: string;
  total: number;
  with_concerns: number;
  hide_students_without_concerns: boolean;
}

async function fetcher(school: SchoolContext, config: ClassroomAllergiesConfig): Promise<Data> {
  const cf = (config.classroom_filter || '').trim();
  const pf = (config.program_filter || '').trim();
  const { rows } = await query<Row>(
    `SELECT
       s.id AS student_id,
       s.first_name, s.last_name, s.preferred_name, s.date_of_birth,
       COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS homeroom,
       s.metadata->>'allergy'              AS allergy,
       s.metadata->>'special_instructions' AS special_instructions,
       s.metadata->>'organic_lunch'        AS organic_lunch,
       shp.allergies                       AS health_allergies,
       shp.medical_conditions              AS health_conditions
     FROM students s
     LEFT JOIN student_health_profiles shp
       ON shp.student_id = s.id AND shp.school_id = s.school_id
     WHERE s.school_id = $1 AND s.status = 'active'
       AND ($2 = '' OR COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') = $2)
       AND ($3 = '' OR s.metadata->>'program' = $3)
     ORDER BY s.last_name, s.first_name`,
    [school.schoolId, cf, pf],
  );

  let withConcerns = 0;
  for (const r of rows) {
    if (hasConcerns(r)) withConcerns++;
  }
  return {
    rows,
    classroom_filter: cf || pf,
    total: rows.length,
    with_concerns: withConcerns,
    hide_students_without_concerns: !!config.hide_students_without_concerns,
  };
}

function isRealAllergy(v: string | null | undefined): boolean {
  if (!v) return false;
  const lower = v.trim().toLowerCase();
  if (!lower) return false;
  return !['no', 'none', 'n/a', 'na', 'no.', 'none.'].includes(lower);
}

function bestAllergy(r: Row): string | null {
  // students.metadata.allergy is the primary source (powers FamilyHubTable);
  // fall back to health profile if metadata is blank/"no".
  if (isRealAllergy(r.allergy)) return r.allergy;
  if (isRealAllergy(r.health_allergies)) return r.health_allergies;
  return null;
}

function bestSpecial(r: Row): string | null {
  const md = r.special_instructions?.trim();
  if (md) return md;
  const hp = r.health_conditions?.trim();
  if (hp) return hp;
  return null;
}

function hasConcerns(r: Row): boolean {
  return !!(bestAllergy(r) || bestSpecial(r));
}

function Component({ data }: { school: SchoolContext; config: ClassroomAllergiesConfig; data: Data }) {
  const display = data.hide_students_without_concerns
    ? data.rows.filter(hasConcerns)
    : data.rows;

  return (
    <div className="space-y-3 print:space-y-2">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2 print:text-xl">
            <AlertTriangle className="h-4 w-4 text-rose-600 print:hidden" /> Allergies &amp; Special Needs &middot; {data.classroom_filter || 'all classrooms'}
          </h2>
          <p className="text-xs text-slate-500 print:text-[11px]">
            {data.with_concerns} of {data.total} student{data.total === 1 ? '' : 's'} with a documented allergy or special-needs note.
            {data.hide_students_without_concerns ? ' (Students without concerns hidden.)' : ''}
          </p>
        </div>
        <PrintButton label="Print roster" title="Print this classroom's allergy + special-needs roster" />
      </div>

      {display.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 text-sm text-emerald-900">
          {data.total === 0
            ? 'No students in this classroom yet.'
            : 'No allergies or special-needs notes on file for this classroom. (Toggle off "hide students without concerns" to see the full roster.)'}
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden print:border-0 print:rounded-none">
          <table className="w-full text-sm print:text-[11px]">
            <thead className="bg-slate-50 border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-600 print:bg-white">
              <tr>
                <th className="px-3 py-2 font-semibold w-[24%]">Student</th>
                <th className="px-3 py-2 font-semibold w-[26%]">Food allergy / dietary</th>
                <th className="px-3 py-2 font-semibold w-[36%]">Special instructions / medical notes</th>
                <th className="px-3 py-2 font-semibold w-[14%]">Lunch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {display.map((r) => {
                const allergy = bestAllergy(r);
                const special = bestSpecial(r);
                return (
                  <tr key={r.student_id} className={`align-top break-inside-avoid ${allergy ? 'print:border-l-4 print:border-l-rose-600' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                        {r.preferred_name || r.first_name} {r.last_name}
                        {allergy ? <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" /> : null}
                      </div>
                      {r.date_of_birth ? (
                        <div className="text-[10px] text-slate-500 print:text-[9px]">DOB: {fmtDob(r.date_of_birth)}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      {allergy ? (
                        <span className="text-rose-700 font-medium whitespace-pre-wrap">{allergy}</span>
                      ) : (
                        <span className="text-slate-300 print:text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-800 text-xs whitespace-pre-wrap print:text-[10.5px]">
                      {special || <span className="text-slate-300 print:text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 inline-flex items-start gap-1 print:text-[10.5px]">
                      {r.organic_lunch ? (
                        <>
                          <Soup className="h-3 w-3 mt-0.5 text-orange-600 print:hidden" />
                          {r.organic_lunch}
                        </>
                      ) : (
                        <span className="text-slate-300 print:text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-md border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-900 flex items-start gap-2 print:hidden">
        <FileWarning className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div>
          This list is read-only. Allergy updates come from the parent portal (Emergency
          Information / OTC Medication form) or the yearly DGM allergies import. To
          change an entry, update it in GHL or have the parent re-submit the relevant form.
        </div>
      </div>
      <p className="text-[10px] text-slate-400 print:block hidden">
        Printed from Growth Suite. Source: students.metadata + student_health_profiles. Updated as parents submit forms or DGM runs the yearly allergies import.
      </p>
    </div>
  );
}

function fmtDob(s: string): string {
  // Accept ISO date string; emit MM/DD/YYYY for printing.
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  } catch {
    return s;
  }
}

const schema: ConfigSchema = {
  fields: [
    { type: 'text',    key: 'classroom_filter', label: 'Classroom (homeroom)', placeholder: 'Classroom 4' },
    { type: 'text',    key: 'program_filter',   label: 'Program (alternative to classroom)', placeholder: 'Upper Elementary' },
    { type: 'boolean', key: 'hide_students_without_concerns',
      label: 'Hide students with no allergy / notes (compact roster)',
      help: 'Off by default — most teachers want to see every name so they can confirm there are no missing flags.' },
  ],
};

export const ClassroomAllergies: WidgetDefinition<ClassroomAllergiesConfig, Data> = {
  id: 'classroom_allergies',
  display_name: 'Classroom Allergies & Special Needs',
  description: 'Per-classroom roster of food allergies, dietary restrictions, and special-needs notes. Print-optimized for posting in the classroom.',
  category: 'student',
  default_config: { classroom_filter: '', hide_students_without_concerns: false },
  config_schema: schema,
  default_size: { w: 12, h: 10 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
