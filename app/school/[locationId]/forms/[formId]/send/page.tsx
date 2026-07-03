// /school/[locationId]/forms/[formId]/send — send THIS form to a specific
// family (optionally a specific child). Creates a tracked invite and can
// email every active parent in the family a one-click magic link
// ("Action needed: <form>"). Backed by the same invite engine as
// enrollments/start; school-scoped (school session OR operator).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Send as SendIcon } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SendFormClient } from './SendFormClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; formId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

export default async function SendFormPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, formId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: defRows } = await query<{
    id: string; slug: string; display_name: string; per_student: boolean; is_active: boolean;
  }>(
    `SELECT id, slug, display_name, per_student, is_active
       FROM portal_form_definitions WHERE id = $1 AND school_id = $2`,
    [formId, school.id],
  );
  if (defRows.length === 0) notFound();
  const def = defRows[0];

  // Families with their primary parent + children, for the picker.
  const { rows: families } = await query<{
    id: string; label: string; parent_email: string | null;
  }>(
    `SELECT f.id,
            COALESCE(NULLIF(f.display_name, ''),
                     (SELECT CONCAT_WS(' ', p.first_name, p.last_name) FROM parents p
                       WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1),
                     '(unnamed family)') AS label,
            (SELECT p.email FROM parents p WHERE p.family_id = f.id AND p.is_primary = true LIMIT 1) AS parent_email
       FROM families f
      WHERE f.school_id = $1 AND f.status = 'active'
      ORDER BY 2`,
    [school.id],
  );
  const { rows: students } = await query<{ id: string; family_id: string; name: string }>(
    `SELECT s.id, s.family_id,
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
      ORDER BY 2`,
    [school.id],
  );

  // After a send, show the tracked invite's shareable link.
  let inviteLink: string | null = null;
  const inviteId = typeof sp.invite_id === 'string' ? sp.invite_id : null;
  if (inviteId) {
    const { rows } = await query<{ token: string }>(
      `SELECT token FROM enrollment_invites WHERE id = $1 AND school_id = $2`,
      [inviteId, school.id],
    );
    if (rows[0]) inviteLink = `${PARENT_PORTAL_BASE}/forms-v2/${def.slug}?invite=${encodeURIComponent(rows[0].token)}`;
  }

  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-xl space-y-4">
        <Link href={`/school/${locationId}/forms/${formId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to form
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
            <SendIcon className="h-5 w-5 text-emerald-700" /> Send &ldquo;{def.display_name}&rdquo;
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Sends every active parent in the family an email with a one-click link to this form
            {def.per_student ? ' for the child you pick' : ''}. You can also just copy the link and share it yourself.
          </p>
        </div>

        {!def.is_active ? (
          <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This form is a draft. Publish it first — parents can&rsquo;t open a draft form.
          </div>
        ) : null}
        {msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}
        {inviteLink ? (
          <div className="rounded border border-emerald-200 bg-white px-3 py-2 text-xs">
            <div className="font-medium text-slate-700 mb-1">Shareable link for this invite (same one the email contains):</div>
            <code className="block break-all text-emerald-800">{inviteLink}</code>
          </div>
        ) : null}

        <SendFormClient
          schoolId={school.id}
          formId={def.id}
          perStudent={def.per_student}
          returnTo={`/school/${locationId}/forms/${formId}/send`}
          families={families}
          students={students}
        />
      </div>
    </main>
  );
}
