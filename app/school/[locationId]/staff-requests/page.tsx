// /school/[locationId]/staff-requests
//
// Landing page for teachers: pick a form to fill out, or jump to
// "My recent requests". The 3 staff forms (audience='staff') are
// dynamically loaded so adding more is a seed change, not code.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText, Wrench, AlertCircle, Package } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { getTeacherIdentity, DGM_STAFF_DIRECTORY } from '@/lib/auth/teacher-identity';
import { IdentityPicker } from './IdentityPicker';
import { IdentityIndicator } from './IdentityIndicator';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ from?: string }>;

interface FormRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
}

const ICON_BY_SLUG: Record<string, React.ComponentType<{ className?: string }>> = {
  'staff-labor-request': Wrench,
  'staff-incident-report': AlertCircle,
  'staff-supply-request': Package,
};

// Validate the `?from=` query param so we only roundtrip known
// classroom slugs. Anything else gets discarded.
function isClassroomSlug(s: string | undefined): boolean {
  return !!s && /^(classroom-|program-)[a-z0-9-]+$/.test(s);
}

// Pretty label for a classroom slug — "classroom-3" -> "Classroom 3",
// "program-06-my-hs" -> "06 MY/HS Hub". Best-effort: the dashboard
// table has a display_name we could query but for nav speed we just
// transform the slug.
function prettyClassroom(slug: string): string {
  const stripped = slug.replace(/^(classroom-|program-)/, '');
  return slug.startsWith('classroom-')
    ? `Classroom ${stripped}`
    : stripped.toUpperCase().replace(/-/g, ' ');
}

export default async function StaffRequestsLanding({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  // Where the teacher came from — preserved across sub-pages so
  // the "Roster" tab links back to their classroom hub.
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const classroomLabel = classroomSlug ? prettyClassroom(classroomSlug) : null;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const teacher = await getTeacherIdentity();
  const thisUrl = `/school/${locationId}/staff-requests?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}`;

  const { rows: forms } = await query<FormRow>(
    `SELECT id, slug, display_name, description
       FROM portal_form_definitions
      WHERE school_id = $1 AND audience = 'staff' AND is_active = true
      ORDER BY display_name`,
    [school.id],
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="submit"
        />
        <div className="mb-5 flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Submit a request</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Pick a form below — Lexi gets notified the moment you submit. Track status in <Link href={`/school/${locationId}/staff-requests/mine?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}`} className="text-blue-600 hover:underline">My Requests</Link>.
            </p>
          </div>
          {teacher ? (
            <IdentityIndicator email={teacher.email} name={teacher.name} returnTo={thisUrl} />
          ) : null}
        </div>

        {!teacher ? (
          <div className="mb-5">
            <IdentityPicker staff={DGM_STAFF_DIRECTORY} returnTo={thisUrl} />
          </div>
        ) : null}

        {forms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 italic">
            No staff request forms are configured for this school yet.
          </div>
        ) : (
          <div className={teacher ? '' : 'opacity-50 pointer-events-none select-none'}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {forms.map((f) => {
                const Icon = ICON_BY_SLUG[f.slug] ?? FileText;
                return (
                  <Link
                    key={f.id}
                    href={`/school/${locationId}/staff-requests/${f.slug}?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}`}
                    className="rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm transition"
                  >
                    <Icon className="h-6 w-6 text-blue-600 mb-2" />
                    <div className="font-semibold text-slate-900">{f.display_name}</div>
                    {f.description ? (
                      <p className="text-xs text-slate-600 mt-1 line-clamp-3">{f.description}</p>
                    ) : null}
                  </Link>
                );
              })}
            </div>
            {!teacher ? (
              <p className="mt-3 text-xs text-slate-500 italic text-center">
                Pick your name above before submitting a form.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
