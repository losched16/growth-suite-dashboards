// /school/[locationId]/lunch-roster
//
// Teacher lunch hub, three sub-tabs:
//   Hot Lunch List (default) — NATIVE printable list of students on the
//     organic hot-lunch program, grouped by classroom. Replaces the
//     teachers' need for the roster's old "Hot lunch only" radio.
//   Menus — the monthly menu images (DgmMenusView).
//   Lunch Admin — the pre-existing external lunch app iframe
//     (DGM_LUNCH_ROSTER_URL), kept for the kitchen/office workflow.
//     Tab renders only when the env URL is configured.
//
// "Has hot lunch" mirrors the roster fetcher's rule: the diet selection
// lives in organic_lunch_choice ("… - Vegetarian"); organic_lunch is
// the FEE ("2100"/"0") from the enrollment form's write_amount
// writeback, so a legacy non-numeric organic_lunch value also counts.
// Anything containing "decline" (or blank) = no hot lunch.
//
// GHL Custom Menu Link target: {appBase}/school/{locationId}/lunch-roster?chrome=none

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { ClipboardList, Image as ImageIcon, Wrench } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getMenuAssetIndex } from '@/lib/menus';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { DgmMenusView } from '@/components/DgmMenusView';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ tab?: string; from?: string }>;

function isClassroomSlug(s: string | undefined): boolean {
  return !!s && /^(classroom-|program-)[a-z0-9-]+$/.test(s);
}
function prettyClassroom(slug: string): string {
  const stripped = slug.replace(/^(classroom-|program-)/, '');
  return slug.startsWith('classroom-')
    ? `Classroom ${stripped}`
    : stripped.toUpperCase().replace(/-/g, ' ');
}

// Same ground-truth lookup as teacher-forms: the hub's roster widget
// stores the exact homeroom label ("Suite 100", not "Classroom suite-100").
async function homeroomLabelForSlug(schoolId: string, slug: string): Promise<string | null> {
  const { rows } = await query<{ layout: unknown }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = $2`,
    [schoolId, slug],
  );
  const widgets = rows[0]?.layout;
  if (Array.isArray(widgets)) {
    for (const w of widgets) {
      const label = (w as { config?: { default_homeroom_filter?: string } })
        ?.config?.default_homeroom_filter;
      if (typeof label === 'string' && label.trim() !== '') return label.trim();
    }
  }
  return null;
}

interface LunchRow {
  student_name: string;
  classroom: string | null;
  grade: string | null;
  lunch_choice: string | null;
  lunch_legacy: string | null;
  allergy: string | null;
}

export default async function LunchRosterPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const fromQs = classroomSlug ? `&from=${classroomSlug}` : '';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const lunchAdminUrl = process.env.DGM_LUNCH_ROSTER_URL ?? '';
  const tab = sp.tab === 'menus' ? 'menus'
    : (sp.tab === 'admin' && lunchAdminUrl) ? 'admin'
    : 'roster';

  const classroomLabel = classroomSlug
    ? (await homeroomLabelForSlug(school.id, classroomSlug)) ?? prettyClassroom(classroomSlug)
    : null;

  const assets = tab === 'menus' ? await getMenuAssetIndex(school.id) : {};

  let groups: Array<{ classroom: string; students: LunchRow[] }> = [];
  let totalOnLunch = 0;
  if (tab === 'roster') {
    const { rows } = await query<LunchRow>(
      `SELECT CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS student_name,
              COALESCE(NULLIF(metadata->>'homeroom',''), metadata->>'classroom_name') AS classroom,
              NULLIF(TRIM(metadata->>'grade_level'), '') AS grade,
              NULLIF(TRIM(metadata->>'organic_lunch_choice'), '') AS lunch_choice,
              NULLIF(TRIM(metadata->>'organic_lunch'), '') AS lunch_legacy,
              NULLIF(TRIM(metadata->>'allergy'), '') AS allergy
         FROM students
        WHERE school_id = $1
          AND status = 'active'
          AND (metadata->>'is_demo') IS DISTINCT FROM 'true'
          AND ($2::text IS NULL
               OR COALESCE(NULLIF(metadata->>'homeroom',''), metadata->>'classroom_name') = $2)
        ORDER BY classroom NULLS LAST, last_name, first_name`,
      [school.id, classroomLabel],
    );

    const byClassroom = new Map<string, LunchRow[]>();
    for (const r of rows) {
      const legacy = r.lunch_legacy && !/^\d+(\.\d+)?$/.test(r.lunch_legacy) ? r.lunch_legacy : null;
      const lunch = r.lunch_choice ?? legacy;
      if (!lunch || lunch.toLowerCase().includes('decline')) continue;
      const key = r.classroom ?? 'No classroom assigned';
      if (!byClassroom.has(key)) byClassroom.set(key, []);
      byClassroom.get(key)!.push({ ...r, lunch_choice: lunch });
      totalOnLunch++;
    }
    groups = [...byClassroom.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([classroom, students]) => ({ classroom, students }));
  }

  const rosterHref = `/school/${locationId}/lunch-roster?chrome=none${fromQs}`;
  const menusHref  = `/school/${locationId}/lunch-roster?chrome=none&tab=menus${fromQs}`;
  const adminHref  = `/school/${locationId}/lunch-roster?chrome=none&tab=admin${fromQs}`;

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="lunch"
        />

        {/* In-page sub-tabs, query-param driven so they work without JS
            and survive ?chrome=none. */}
        <nav className="border-b border-slate-200 mb-4 -mx-4 sm:-mx-6 px-4 sm:px-6 print:hidden">
          <div className="flex items-center gap-1">
            <SubTab
              href={rosterHref}
              active={tab === 'roster'}
              icon={<ClipboardList className="h-3.5 w-3.5" />}
              label="Hot Lunch List"
            />
            <SubTab
              href={menusHref}
              active={tab === 'menus'}
              icon={<ImageIcon className="h-3.5 w-3.5" />}
              label="Menus"
            />
            {lunchAdminUrl ? (
              <SubTab
                href={adminHref}
                active={tab === 'admin'}
                icon={<Wrench className="h-3.5 w-3.5" />}
                label="Lunch Admin"
              />
            ) : null}
          </div>
        </nav>

        {tab === 'menus' ? (
          <DgmMenusView assets={assets} />
        ) : tab === 'admin' ? (
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            {/* The pre-existing external lunch app (kitchen/office tool);
                same source the GHL Custom Menu Link used to point at. */}
            <iframe
              src={lunchAdminUrl}
              title="DGM Lunch Roster (admin)"
              style={{ width: '100%', height: '820px', border: 0 }}
              loading="lazy"
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  Hot Lunch{classroomLabel ? ` — ${classroomLabel}` : ''}
                </h1>
                <p className="text-sm text-slate-600">
                  {totalOnLunch} student{totalOnLunch === 1 ? '' : 's'} on the organic lunch
                  program{classroomLabel ? '' : ', grouped by classroom'}. Diet shown as
                  selected on the enrollment agreement.
                </p>
              </div>
              <PrintButton label="Print list" title="Print the hot-lunch list" />
            </div>

            {groups.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                No students on hot lunch{classroomLabel ? ` in ${classroomLabel}` : ''}.
              </div>
            ) : (
              <div className="space-y-5 print:space-y-3">
                {groups.map((g) => (
                  <section
                    key={g.classroom}
                    className="rounded-lg border border-slate-200 bg-white overflow-hidden print:border-0 print:rounded-none print:break-inside-avoid"
                  >
                    <h2 className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-900 print:bg-white print:border-b-2 print:border-slate-300">
                      {g.classroom}
                      <span className="ml-2 font-normal text-slate-400">({g.students.length})</span>
                    </h2>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                          <th className="px-4 py-1.5 font-medium">Student</th>
                          <th className="px-4 py-1.5 font-medium">Grade</th>
                          <th className="px-4 py-1.5 font-medium">Lunch selection</th>
                          <th className="px-4 py-1.5 font-medium">Allergies</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {g.students.map((s) => (
                          <tr key={s.student_name}>
                            <td className="px-4 py-1.5 font-medium text-slate-800">{s.student_name}</td>
                            <td className="px-4 py-1.5 text-slate-600">{s.grade ?? '—'}</td>
                            <td className="px-4 py-1.5 text-slate-600">{s.lunch_choice}</td>
                            <td className="px-4 py-1.5 text-rose-700">{s.allergy ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function SubTab({
  href, active, icon, label,
}: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap';
  const cls = active
    ? `${base} border-blue-600 text-blue-700 font-semibold`
    : `${base} border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300`;
  return (
    <Link href={href} className={cls}>
      {icon}
      {label}
    </Link>
  );
}
