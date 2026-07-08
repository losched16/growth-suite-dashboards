// /school/[locationId]/forms/[formId]/send — push THIS form to one family
// (optionally a specific child), to ALL families, or to a group (by contact
// tag, program, or grade). Creates tracked invites and emails each family a
// "form waiting in your portal" link. Backed by the same invite engine as
// enrollments/start; school-scoped (school session OR operator).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Send as SendIcon } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { parentPortalBaseForSchool } from '@/lib/parent-portal-base';
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
  const { rows: students } = await query<{
    id: string; family_id: string; name: string;
    program: string | null; grade: string | null; enr_status: string | null;
  }>(
    `SELECT s.id, s.family_id,
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name,
            s.metadata->>'program' AS program,
            s.metadata->>'grade_level' AS grade,
            e.status AS enr_status
       FROM students s
       LEFT JOIN LATERAL (
         SELECT e2.status FROM enrollments e2 WHERE e2.student_id = s.id
          ORDER BY e2.created_at DESC LIMIT 1
       ) e ON true
      WHERE s.school_id = $1 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
      ORDER BY 3`,
    [school.id],
  );

  // Family → contact tags, for the "by tag" recipient estimate.
  const { rows: famTagRows } = await query<{ family_id: string; tag: string }>(
    `SELECT DISTINCT p.family_id, t.tag
       FROM ghl_contact_tags t
       JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
      WHERE t.school_id = $1 AND p.school_id = $1 AND p.status = 'active'
        AND btrim(coalesce(t.tag, '')) <> ''`,
    [school.id],
  );
  const familyTags: Record<string, string[]> = {};
  for (const r of famTagRows) {
    (familyTags[r.family_id] ??= []).push(r.tag);
  }
  const tagOptions = [...new Set(famTagRows.map((r) => r.tag))].sort((a, b) => a.localeCompare(b));
  const programOptions = [...new Set(students.map((s) => s.program).filter((v): v is string => !!v))].sort();
  const gradeOptions = [...new Set(students.map((s) => s.grade).filter((v): v is string => !!v))].sort();

  // After a send, show the tracked invite's shareable link.
  let inviteLink: string | null = null;
  const inviteId = typeof sp.invite_id === 'string' ? sp.invite_id : null;
  if (inviteId) {
    const { rows } = await query<{ token: string }>(
      `SELECT token FROM enrollment_invites WHERE id = $1 AND school_id = $2`,
      [inviteId, school.id],
    );
    if (rows[0]) inviteLink = `${await parentPortalBaseForSchool(school.id)}/forms-v2/${def.slug}?invite=${encodeURIComponent(rows[0].token)}`;
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
            Push this form to one family, to everyone, or to a group (by tag, program, or grade).
            It appears in their portal Forms list, and each parent gets a &ldquo;form waiting for
            you&rdquo; email with a one-click link.
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
          formName={def.display_name}
          perStudent={def.per_student}
          returnTo={`/school/${locationId}/forms/${formId}/send`}
          families={families}
          students={students}
          familyTags={familyTags}
          tagOptions={tagOptions}
          programOptions={programOptions}
          gradeOptions={gradeOptions}
        />
      </div>
    </main>
  );
}
