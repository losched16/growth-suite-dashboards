// /school/[locationId]/staff-directory
//
// Office editor for the staff identity roster (school_staff_directory,
// migration 103): the names offered in the "Pick your name" dropdown
// on Staff Forms / My Submissions / the menu editor.
//
// Deliberately NOT in the teacher tab bar — the office reaches it by
// direct link (CRM custom link or bookmark). Any school-session holder
// can technically open it (same URL-trust model as the forms builder);
// it edits only the picker roster, never submissions or permissions.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getStaffDirectory } from '@/lib/auth/staff-directory';
import { DirectoryEditor } from './DirectoryEditor';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export default async function StaffDirectoryPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const staff = await getStaffDirectory(school.id);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        <h1 className="text-xl font-bold text-slate-900">Staff Directory</h1>
        <p className="text-sm text-slate-600 mt-1 mb-4">
          These are the names staff can pick from when submitting Staff Forms or
          editing menus. Add people as they join; remove them when they leave.
          Changes take effect immediately — no tech involvement needed.
        </p>
        <DirectoryEditor initialStaff={staff} />
        <p className="text-xs text-slate-500 mt-4">
          Removing someone only takes them out of the pick-list. Their past
          submissions keep their name, and a device where they already picked
          their name stays identified for up to 30 days.
        </p>
      </div>
    </main>
  );
}
