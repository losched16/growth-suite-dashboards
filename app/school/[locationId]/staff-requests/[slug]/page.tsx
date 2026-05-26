// /school/[locationId]/staff-requests/[slug]
//
// Renders one staff form (Labor / Incident / Supplies) with live
// interactive inputs. Submit POSTs to /api/school/staff-requests/submit
// which inserts the row + emails Lexi.
//
// We reuse the TestSubmitForm renderer from the form preview — it
// already handles every field type, validation, and submission UX.
// The endpoint URL is the only thing that differs.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { getTeacherIdentity } from '@/lib/auth/teacher-identity';
import { IdentityIndicator } from '../IdentityIndicator';
import { StaffSubmitForm } from './StaffSubmitForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; slug: string }>;
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

interface FormRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  field_schema: unknown[];
  audience: string;
}

export default async function StaffFormFillPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, slug } = await params;
  const sp = await searchParams;
  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const classroomLabel = classroomSlug ? prettyClassroom(classroomSlug) : null;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<FormRow>(
    `SELECT id, slug, display_name, description, field_schema, audience
       FROM portal_form_definitions
      WHERE school_id = $1 AND slug = $2 AND is_active = true`,
    [school.id, slug],
  );
  if (rows.length === 0 || rows[0].audience !== 'staff') notFound();
  const form = rows[0];

  // Submissions require an identified teacher (cookie is the source of
  // truth). If they bookmarked the form URL or hit it before picking
  // their name, bounce them to the landing page where the picker lives
  // — the landing remembers the `from=` classroom so they don't lose
  // their context.
  const teacher = await getTeacherIdentity();
  if (!teacher) {
    const fromQs = classroomSlug ? `&from=${classroomSlug}` : '';
    redirect(`/school/${locationId}/staff-requests?chrome=none${fromQs}`);
  }

  const returnTo = `/school/${locationId}/staff-requests/mine?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}&submitted=${form.slug}`;
  const thisUrl = `/school/${locationId}/staff-requests/${form.slug}?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}`;

  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="submit"
        />
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <Link
            href={`/school/${locationId}/staff-requests?chrome=none${classroomSlug ? `&from=${classroomSlug}` : ''}`}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700"
          >
            <ArrowLeft className="h-3 w-3" /> All staff requests
          </Link>
          <IdentityIndicator email={teacher.email} name={teacher.name} returnTo={thisUrl} />
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">{form.display_name}</h1>
            {form.description ? (
              <p className="text-sm text-zinc-600 mt-1 whitespace-pre-wrap">{form.description}</p>
            ) : null}
          </div>

          <StaffSubmitForm
            formId={form.id}
            schema={form.field_schema}
            returnTo={returnTo}
          />
        </div>
      </div>
    </main>
  );
}
