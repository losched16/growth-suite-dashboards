// /school/[locationId]/menus
//
// Standalone page that shows the DGM menus (Harvest of the Month +
// weekly snack + monthly lunch calendar). Linked from the Menus tab
// in ClassroomTopNav, so teachers can reach it from any classroom
// hub or staff-requests page.
//
// Also embedded as one of two tabs on /lunch-roster — see that page
// for the wrapper around DGM's external lunch-roster iframe.

import { notFound } from 'next/navigation';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { DgmMenusView } from '@/components/DgmMenusView';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ from?: string }>;

function isClassroomSlug(s: string | undefined): boolean {
  return !!s && /^(classroom-|program-)[a-z0-9-]+$/.test(s);
}
function prettyClassroom(slug: string): string {
  const stripped = slug.replace(/^(classroom-|program-)/, '');
  return slug.startsWith('classroom-')
    ? `Classroom ${stripped}`
    : stripped.toUpperCase().replace(/-/g, ' ');
}

export default async function MenusPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const classroomLabel = classroomSlug ? prettyClassroom(classroomSlug) : null;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="menus"
        />
        <DgmMenusView />
      </div>
    </main>
  );
}
