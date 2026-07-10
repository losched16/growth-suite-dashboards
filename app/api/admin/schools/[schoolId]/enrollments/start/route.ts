// POST /api/admin/schools/{schoolId}/enrollments/start
//
// Push a portal form to families. Creates enrollment_invites row(s) +
// optionally emails each family a "form waiting in your portal" link.
// Returns 303 back to the start/send page so the operator sees the
// result inline.
//
// recipient_mode:
//   'family' (default) — one family (family_id), optional student_id
//   'all'              — every family with an enrolled/pending student
//   'tag'              — families whose contact carries the tag (field: tag)
//   'program'          — families with a student in the program (field: program)
//   'grade'            — families with a student in the grade (field: grade)
// Group modes create one family-wide invite per family (student_id null).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { loadSchoolSettings } from '@/lib/school-settings';
import { parentPortalBaseForSchool } from '@/lib/parent-portal-base';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bulk pushes send one email per parent across a whole school — give the
// function room to finish (Resend calls are ~100-300ms each).
export const maxDuration = 300;

type Params = Promise<{ schoolId: string }>;

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

// Where to redirect after the POST. Defaults to /admin/{schoolId}/...
// but accepts a `returnTo` override from the caller so the school-scoped
// page (/school/{locationId}/enrollments/start) can keep the operator
// inside the GHL iframe.
//
// returnTo MUST start with `/admin/` or `/school/` and contain no
// scheme/host — otherwise we drop it and fall back to the default. This
// prevents an open-redirect using the form to bounce users off-host.
function safeReturnPath(returnTo: string | null, schoolId: string): string {
  if (returnTo && /^\/(admin|school)\/[A-Za-z0-9_-]+\/(enrollments\/start|forms\/[A-Za-z0-9-]+\/send)$/.test(returnTo)) {
    return returnTo;
  }
  return `/admin/${schoolId}/enrollments/start`;
}

function back(
  request: NextRequest,
  schoolId: string,
  q: { msg?: string; err?: string; invite_id?: string },
  returnTo: string | null = null,
) {
  const url = request.nextUrl.clone();
  url.pathname = safeReturnPath(returnTo, schoolId);
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  if (q.invite_id) url.searchParams.set('invite_id', q.invite_id);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  // Operator OR the school itself (school session) — this endpoint sends
  // parent-facing email, so it must never be anonymous.
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;
  const fd = await request.formData();

  // Where to bounce the operator on success/failure. The school-scoped
  // page (/school/{locationId}/enrollments/start) sets this to its own
  // path so the operator stays inside the GHL iframe. The /admin/ page
  // omits it, falling through to /admin/{schoolId}/enrollments/start.
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  const formDefId = String(fd.get('form_definition_id') ?? '').trim();
  const familyId = String(fd.get('family_id') ?? '').trim();
  const studentIdRaw = String(fd.get('student_id') ?? '').trim();
  const studentId = studentIdRaw || null;
  const internalNote = String(fd.get('internal_note') ?? '').trim() || null;
  const sendEmail = fd.get('send_email') === '1';
  const recipientMode = String(fd.get('recipient_mode') ?? 'family').trim() || 'family';
  const groupValue = String(fd.get('group_value') ?? '').trim();

  if (!formDefId) return back(request, schoolId, { err: 'Form is required.' }, returnTo);
  if (recipientMode === 'family' && !familyId) {
    return back(request, schoolId, { err: 'Family is required.' }, returnTo);
  }
  if ((recipientMode === 'tag' || recipientMode === 'program' || recipientMode === 'grade') && !groupValue) {
    return back(request, schoolId, { err: 'Pick a tag / program / grade first.' }, returnTo);
  }

  // Validate the form belongs to this school
  const { rows: defRows } = await query<{ id: string; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [formDefId, schoolId],
  );
  if (defRows.length === 0) {
    return back(request, schoolId, { err: 'Form not found or inactive.' }, returnTo);
  }
  const def = defRows[0];

  // Resolve the target family list.
  let targetFamilyIds: string[];
  if (recipientMode === 'family') {
    const { rows: famRows } = await query<{ id: string }>(
      `SELECT id FROM families WHERE id = $1 AND school_id = $2`,
      [familyId, schoolId],
    );
    if (famRows.length === 0) {
      return back(request, schoolId, { err: 'Family not found.' }, returnTo);
    }
    targetFamilyIds = [familyId];
  } else {
    const settings = await loadSchoolSettings(schoolId);
    // Group modes only ever reach the real portal population: families with
    // a currently-enrolled or pending (mid-admissions) student. Withdrawn
    // families and stale prospects keep their program/grade values in GHL,
    // so without this scope a "send to Upper Elementary" would email them too.
    const scopedFamilies = `
      SELECT DISTINCT s.family_id
        FROM students s
        LEFT JOIN LATERAL (
          SELECT e2.status FROM enrollments e2 WHERE e2.student_id = s.id
           ORDER BY (e2.academic_year = $2) DESC, e2.created_at DESC LIMIT 1
        ) e ON true
       WHERE s.school_id = $1 AND s.status = 'active'
         AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
         AND e.status IN ('enrolled', 'pending')`;
    let rows: Array<{ family_id: string }>;
    if (recipientMode === 'all') {
      rows = (await query<{ family_id: string }>(scopedFamilies, [schoolId, settings.academic_year])).rows;
    } else if (recipientMode === 'tag') {
      rows = (await query<{ family_id: string }>(
        `${scopedFamilies}
           AND EXISTS (
             SELECT 1 FROM parents p
               JOIN ghl_contact_tags t ON t.ghl_contact_id = p.ghl_contact_id AND t.school_id = $1
              WHERE p.family_id = s.family_id AND p.status = 'active' AND p.is_primary = true
                AND LOWER(t.tag) = LOWER($3)
           )`,
        [schoolId, settings.academic_year, groupValue],
      )).rows;
    } else if (recipientMode === 'program' || recipientMode === 'grade') {
      const metaKey = recipientMode === 'program' ? 'program' : 'grade_level';
      rows = (await query<{ family_id: string }>(
        `${scopedFamilies}
           AND LOWER(COALESCE(s.metadata->>'${metaKey}', '')) = LOWER($3)`,
        [schoolId, settings.academic_year, groupValue],
      )).rows;
    } else {
      return back(request, schoolId, { err: `Unknown recipient mode "${recipientMode}".` }, returnTo);
    }
    targetFamilyIds = rows.map((r) => r.family_id);
    if (targetFamilyIds.length === 0) {
      return back(request, schoolId, { err: 'No matching families — nothing sent.' }, returnTo);
    }
  }

  // Build prefill jsonb from any `prefill_*` form fields
  const prefill: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof key !== 'string') continue;
    if (!key.startsWith('prefill_')) continue;
    const v = String(value).trim();
    if (!v) continue;
    prefill[key.slice('prefill_'.length)] = v;
  }

  const operatorEmail = 'operator@growthsuite.local';
  const { rows: schoolRows } = await query<{ name: string }>(
    `SELECT name FROM schools WHERE id = $1`, [schoolId],
  );
  const schoolName = schoolRows[0]?.name ?? 'Your school';
  const portalBase = await parentPortalBaseForSchool(schoolId);

  // Student name for the email, when a single family + child was picked.
  let studentName: string | null = null;
  if (studentId) {
    const { rows: stRows } = await query<{ name: string }>(
      `SELECT CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
         FROM students WHERE id = $1 AND school_id = $2`,
      [studentId, schoolId],
    );
    studentName = stRows[0]?.name ?? null;
  }

  // One invite per family; one email per unique parent address per family
  // (co-guardians often share an inbox — they should get ONE email, not two).
  let familiesInvited = 0;
  let emailSent = 0;
  let emailFailed = 0;
  let lastEmailErr: string | null = null;
  let firstInviteId: string | null = null;

  for (const fid of targetFamilyIds) {
    // Generate a random URL-safe token. 24 bytes base64url = ~32 chars.
    const token = crypto.randomBytes(24).toString('base64url');
    let inviteId: string;
    try {
      const { rows: insRows } = await query<{ id: string }>(
        `INSERT INTO enrollment_invites
           (school_id, form_definition_id, family_id, student_id,
            token, prefill, internal_note, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          schoolId, formDefId, fid,
          recipientMode === 'family' ? studentId : null,
          token, JSON.stringify(prefill), internalNote, operatorEmail,
        ],
      );
      inviteId = insRows[0].id;
      familiesInvited++;
      if (!firstInviteId) firstInviteId = inviteId;
    } catch {
      continue; // one bad family must not kill a bulk push
    }

    if (!sendEmail) continue;
    const inviteUrl = `${portalBase}/forms-v2/${def.slug}?invite=${encodeURIComponent(token)}`;
    try {
      const { rows: parents } = await query<{ email: string; first_name: string | null }>(
        `SELECT email, first_name FROM parents
          WHERE family_id = $1 AND school_id = $2 AND status = 'active' AND email IS NOT NULL`,
        [fid, schoolId],
      );
      const seen = new Set<string>();
      let sentForFamily = 0;
      for (const p of parents) {
        const addr = p.email.trim().toLowerCase();
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        try {
          const copy = {
            firstName: p.first_name,
            schoolName,
            formName: def.display_name,
            studentName: recipientMode === 'family' ? studentName : null,
            inviteUrl,
          };
          await sendBrandedEmail({
            to: p.email,
            schoolId,
            subject: `You have a form waiting in your Family Portal: ${def.display_name}`,
            html: buildInviteHtml(copy),
            text: buildInviteText(copy),
          });
          emailSent++;
          sentForFamily++;
        } catch (e) {
          emailFailed++;
          lastEmailErr = e instanceof Error ? e.message : String(e);
        }
      }
      if (sentForFamily > 0) {
        await query(`UPDATE enrollment_invites SET sent_at = now() WHERE id = $1`, [inviteId]);
      }
    } catch (e) {
      emailFailed++;
      lastEmailErr = e instanceof Error ? e.message : String(e);
    }
  }

  const who = recipientMode === 'family'
    ? 'the family'
    : `${familiesInvited} famil${familiesInvited === 1 ? 'y' : 'ies'}`;
  const msg = sendEmail
    ? (emailSent > 0
        ? `Form pushed to ${who} — ${emailSent} email(s) sent${emailFailed > 0 ? `, ${emailFailed} failed` : ''}.`
        : (lastEmailErr
            ? `Form pushed to ${who}. Email failed: ${lastEmailErr}. Copy the link below to share manually.`
            : `Form pushed to ${who}. No active parent emails on file — copy the link below to share manually.`))
    : `Form pushed to ${who} (no email sent). It now shows in their portal; copy the link below to share manually.`;

  return back(
    request, schoolId,
    { msg, ...(recipientMode === 'family' && firstInviteId ? { invite_id: firstInviteId } : {}) },
    returnTo,
  );
}

interface InviteCopy {
  firstName: string | null;
  schoolName: string;
  formName: string;
  studentName: string | null;
  inviteUrl: string;
}

function buildInviteHtml(opts: InviteCopy): string {
  const greeting = opts.firstName ? `Hi ${escape(opts.firstName)},` : 'Hi,';
  const forStudent = opts.studentName ? ` for <strong>${escape(opts.studentName)}</strong>` : '';
  return `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">You have a form waiting in your Family Portal</h2>
  <p style="margin: 0 0 16px; font-size: 14px;">${greeting}</p>
  <p style="margin: 0 0 16px; font-size: 14px;">
    ${escape(opts.schoolName)} has sent a form to your Family Portal that needs your attention${forStudent}:
  </p>
  <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600;">${escape(opts.formName)}</p>
  <p style="margin: 16px 0;">
    <a href="${opts.inviteUrl}" style="display: inline-block; background: #047857; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Open the form →
    </a>
  </p>
  <p style="margin: 0 0 16px; font-size: 13px; color: #374151;">
    Sign in with this email address. If you haven&rsquo;t set up your portal account yet,
    you&rsquo;ll be prompted to create a password first — the form will be waiting in your Forms list.
  </p>
  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    This link is unique to your family. If you didn&rsquo;t expect this email, you can ignore it.
  </p>
</body></html>`.trim();
}

function buildInviteText(opts: InviteCopy): string {
  const greeting = opts.firstName ? `Hi ${opts.firstName},\n\n` : '';
  const forStudent = opts.studentName ? ` for ${opts.studentName}` : '';
  return `${greeting}${opts.schoolName} has sent a form to your Family Portal that needs your attention${forStudent}:

${opts.formName}

Open the form:
${opts.inviteUrl}

Sign in with this email address. If you haven't set up your portal account yet, you'll be prompted to create a password first — the form will be waiting in your Forms list.

This link is unique to your family.`;
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}
