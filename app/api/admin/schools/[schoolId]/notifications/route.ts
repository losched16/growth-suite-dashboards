// POST /api/admin/schools/{schoolId}/notifications
//
// Compose + SEND an in-portal notification to a targeted audience. We
// resolve the audience to a frozen recipient list at send time and write
// one delivery row per parent, so read/unread is per-parent and the
// audience can't drift after the fact.
//
// Body: { title, body, link_url?, link_label?, pinned?, audience }

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query, withTransaction } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { resolveRecipients, sanitizeAudience, summarizeAudience } from '@/lib/notifications/audience';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

// Operator session OR a school session for the SAME school.
async function authorize(schoolId: string): Promise<{ ok: true; email: string | null } | { ok: false; status: 401 | 403 }> {
  const ck = await cookies();
  const op = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  if (op) return { ok: true, email: typeof op === 'object' && op && 'email' in op ? String((op as { email?: unknown }).email ?? '') || null : null };
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss && ss.school_id === schoolId) return { ok: true, email: null };
  return { ok: false, status: ss ? 403 : 401 };
}

interface Body {
  title?: unknown;
  body?: unknown;
  link_url?: unknown;
  link_label?: unknown;
  pinned?: unknown;
  audience?: unknown;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const auth = await authorize(schoolId);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!title) return NextResponse.json({ error: 'missing_title' }, { status: 400 });
  if (!text) return NextResponse.json({ error: 'missing_body' }, { status: 400 });

  const audience = sanitizeAudience(body.audience);
  if (!audience) return NextResponse.json({ error: 'invalid_audience', detail: 'Pick at least one audience.' }, { status: 400 });

  // Only allow http(s) links.
  const rawLink = typeof body.link_url === 'string' ? body.link_url.trim() : '';
  const linkUrl = rawLink && /^https?:\/\//i.test(rawLink) ? rawLink : null;
  const linkLabel = linkUrl && typeof body.link_label === 'string' && body.link_label.trim()
    ? body.link_label.trim().slice(0, 60) : null;
  const pinned = body.pinned === true || body.pinned === 'true';

  const recipients = await resolveRecipients(schoolId, audience);
  if (recipients.length === 0) {
    return NextResponse.json({ error: 'no_recipients', detail: 'That audience matches no parents right now.' }, { status: 400 });
  }

  const id = await withTransaction(async (q) => {
    const { rows } = await q<{ id: string }>(
      `INSERT INTO portal_notifications
         (school_id, title, body, link_url, link_label, pinned, audience, audience_label, recipient_count, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING id`,
      [schoolId, title, text, linkUrl, linkLabel, pinned, JSON.stringify(audience),
       summarizeAudience(audience), recipients.length, auth.email],
    );
    const notifId = rows[0].id;
    await q(
      `INSERT INTO portal_notification_recipients (notification_id, school_id, parent_id, family_id)
       SELECT $1, $2, pid, fid
         FROM unnest($3::uuid[], $4::uuid[]) AS t(pid, fid)
       ON CONFLICT (notification_id, parent_id) DO NOTHING`,
      [notifId, schoolId, recipients.map((r) => r.parent_id), recipients.map((r) => r.family_id)],
    );
    return notifId;
  });

  return NextResponse.json({ ok: true, id, recipient_count: recipients.length });
}

// DELETE /api/admin/schools/{schoolId}/notifications?id=<uuid>
// Retract a notification (cascades its delivery rows).
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const auth = await authorize(schoolId);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  await query(
    `DELETE FROM portal_notifications WHERE id = $1 AND school_id = $2`,
    [id, schoolId],
  );
  return NextResponse.json({ ok: true });
}
