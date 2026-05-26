// /school/[locationId]/menus/edit
//
// Designated-editor UI for swapping menu images. Gated by the
// school_menu_editors allowlist (managed via /admin/[schoolId]/menu-editors).
//
// Non-editors hitting this URL get a read-only notice + a back link
// to the view-only menus page.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { ArrowLeft, Lock, ImageIcon } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity, DGM_STAFF_DIRECTORY } from '@/lib/auth/teacher-identity';
import { MENU_SLOTS, isMenuEditor, getMenuAssetIndex } from '@/lib/menus';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { IdentityPicker } from '../../staff-requests/IdentityPicker';
import { IdentityIndicator } from '../../staff-requests/IdentityIndicator';
import { MenuSlotEditor } from './MenuSlotEditor';

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

export default async function MenuEditorPage({
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

  const thisUrl = `/school/${locationId}/menus/edit?chrome=none${fromQs}`;
  const viewUrl = `/school/${locationId}/menus?chrome=none${fromQs}`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="menus"
        />

        <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <ImageIcon className="h-6 w-6 text-blue-600" /> Edit menus
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Replace any of the three menu images with the current month&rsquo;s
              version. Changes are live for every staff member within ~1 minute.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {teacher ? (
              <IdentityIndicator email={teacher.email} name={teacher.name} returnTo={thisUrl} />
            ) : null}
            <Link
              href={viewUrl}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> View menus
            </Link>
          </div>
        </div>

        {!teacher ? (
          <div className="mb-4">
            <IdentityPicker staff={DGM_STAFF_DIRECTORY} returnTo={thisUrl} />
          </div>
        ) : !editor ? (
          <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-5">
            <div className="flex items-start gap-3">
              <Lock className="h-6 w-6 text-amber-700 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-amber-900">You&rsquo;re not a menu editor</h2>
                <p className="mt-1 text-xs text-amber-900">
                  Only designated staff can replace menu images. To request access, ask the
                  operator to add <span className="font-mono">{teacher.email}</span> on the
                  Menu Editors admin page.
                </p>
                <Link href={viewUrl} className="mt-3 inline-flex items-center gap-1 text-xs text-blue-700 underline">
                  Back to the menus
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {MENU_SLOTS.map((slot) => (
              <MenuSlotEditor
                key={slot.key}
                slot={slot.key}
                label={slot.label}
                sub={slot.sub}
                hasUpload={!!assets[slot.key]}
                lastUploadedAt={assets[slot.key]?.uploaded_at?.toString() ?? null}
                lastUploadedBy={assets[slot.key]?.uploaded_by ?? null}
                fallbackPath={slot.fallbackPath}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
