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
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Pencil } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity } from '@/lib/auth/teacher-identity';
import { getMenuAssetIndex, isMenuEditor } from '@/lib/menus';
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
  const fromQs = classroomSlug ? `&from=${classroomSlug}` : '';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const teacher = await getTeacherIdentity();
  const editor = teacher ? await isMenuEditor(school.id, teacher.email) : false;
  const assets = await getMenuAssetIndex(school.id);

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="menus"
        />
        {editor ? (
          <div className="flex justify-end mb-2 print:hidden">
            <Link
              href={`/school/${locationId}/menus/edit?chrome=none${fromQs}`}
              className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit menus
            </Link>
          </div>
        ) : null}
        <DgmMenusView assets={assets} />
      </div>
    </main>
  );
}
