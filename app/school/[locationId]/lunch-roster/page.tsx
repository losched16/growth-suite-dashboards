// /school/[locationId]/lunch-roster
//
// Wrapper around DGM's existing external Lunch Roster app
// (https://desert-garden-admin.vercel.app/lunch?token=…) with a tab
// to switch between the live roster and the menus view.
//
// Why wrap it: DGM staff used to hit the external app directly via a
// GHL Custom Menu Link. They want the menus alongside without losing
// the lunch roster. We can't add tabs inside the external app, so
// this page embeds it as an iframe and provides the tab bar.
//
// Update the GHL Custom Menu Link to point here instead of the raw
// vercel.app URL once this ships:
//   {appBase}/school/{locationId}/lunch-roster?chrome=none
//
// External URL comes from env: DGM_LUNCH_ROSTER_URL. Keeps the embed
// token out of git and lets us rotate it without a redeploy.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ClipboardList, Image as ImageIcon } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { DgmMenusView } from '@/components/DgmMenusView';

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

export default async function LunchRosterPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const tab = sp.tab === 'menus' ? 'menus' : 'roster';
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const classroomLabel = classroomSlug ? prettyClassroom(classroomSlug) : null;
  const fromQs = classroomSlug ? `&from=${classroomSlug}` : '';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // DGM's existing external dashboard. Env var so the embed token
  // stays out of git; falls back to the known URL so a missing env
  // var doesn't 500 the page — staff just see a friendly notice.
  const lunchRosterUrl = process.env.DGM_LUNCH_ROSTER_URL ?? '';

  const rosterHref = `/school/${locationId}/lunch-roster?chrome=none${fromQs}`;
  const menusHref  = `/school/${locationId}/lunch-roster?chrome=none&tab=menus${fromQs}`;

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="lunch"
        />

        {/* In-page sub-tabs: Lunch Roster | Menus. Query-param driven
            so it works without JS and survives ?chrome=none. */}
        <nav className="border-b border-slate-200 mb-4 -mx-4 sm:-mx-6 px-4 sm:px-6 print:hidden">
          <div className="flex items-center gap-1">
            <SubTab
              href={rosterHref}
              active={tab === 'roster'}
              icon={<ClipboardList className="h-3.5 w-3.5" />}
              label="Lunch Roster"
            />
            <SubTab
              href={menusHref}
              active={tab === 'menus'}
              icon={<ImageIcon className="h-3.5 w-3.5" />}
              label="Menus"
            />
          </div>
        </nav>

        {tab === 'roster' ? (
          lunchRosterUrl ? (
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              {/* External app iframe — same source the GHL Custom Menu
                  Link used to point at directly. Height matches what
                  DGM's existing embed uses. */}
              <iframe
                src={lunchRosterUrl}
                title="DGM Lunch Roster"
                style={{ width: '100%', height: '820px', border: 0 }}
                loading="lazy"
              />
            </div>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold mb-1">Lunch Roster URL not configured</p>
              <p className="text-xs">
                Set <code>DGM_LUNCH_ROSTER_URL</code> in <code>.env.local</code> (and Vercel) to
                the full embed URL, e.g. <code>https://desert-garden-admin.vercel.app/lunch?token=…</code>
              </p>
              <p className="text-xs mt-2">
                In the meantime, switch to the <Link href={menusHref} className="underline">Menus tab</Link>.
              </p>
            </div>
          )
        ) : (
          <DgmMenusView />
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
