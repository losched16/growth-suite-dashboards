// POST /api/school/staff-requests/{id}/action
//
// Lexi (or anyone with the school session) takes action on a staff
// request submission:
//   action=acknowledge       -> resolved_status='acknowledged', stamps acknowledged_at
//   action=schedule          -> resolved_status='scheduled', sets scheduled_date + scheduled_at
//   action=complete          -> resolved_status='completed', stamps completed_at
//   action=reject            -> resolved_status='rejected', stamps completed_at
//   action=update_notes      -> just persists admin_notes
//   action=reassign          -> changes assigned_to_email
//
// All actions are 303-redirect back to the inbox so the form-based
// UI works without JS. Pass `return_to` to override the redirect.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const fd = await request.formData();
  const action = String(fd.get('action') ?? '').trim();
  const returnToRaw = String(fd.get('return_to') ?? '').trim();
  const safeReturn = returnToRaw && /^\/school\/[A-Za-z0-9_-]+\//.test(returnToRaw)
    ? returnToRaw
    : `/school/${session.ghl_location_id}/staff-requests/inbox`;

  // Verify the submission belongs to this school + is a staff request.
  const { rows: sub } = await query<{ id: string; submitter_email: string | null }>(
    `SELECT id, submitter_email FROM portal_form_submissions
      WHERE id = $1 AND school_id = $2`,
    [id, session.school_id],
  );
  if (sub.length === 0) {
    return NextResponse.json({ error: 'submission_not_found' }, { status: 404 });
  }
  if (!sub[0].submitter_email) {
    return NextResponse.json({ error: 'not_a_staff_submission' }, { status: 400 });
  }

  switch (action) {
    case 'acknowledge':
      await query(
        `UPDATE portal_form_submissions
            SET resolved_status='acknowledged',
                acknowledged_at = COALESCE(acknowledged_at, now())
          WHERE id = $1`, [id]);
      break;

    case 'schedule': {
      const scheduledDateRaw = String(fd.get('scheduled_date') ?? '').trim();
      if (!scheduledDateRaw) {
        const url = new URL(safeReturn, request.url);
        url.searchParams.set('err', 'Scheduled date is required.');
        return NextResponse.redirect(url, 303);
      }
      await query(
        `UPDATE portal_form_submissions
            SET resolved_status='scheduled',
                scheduled_date=$2::date,
                scheduled_at = now(),
                acknowledged_at = COALESCE(acknowledged_at, now())
          WHERE id = $1`, [id, scheduledDateRaw]);
      break;
    }

    case 'complete':
      await query(
        `UPDATE portal_form_submissions
            SET resolved_status='completed',
                completed_at = now(),
                acknowledged_at = COALESCE(acknowledged_at, now())
          WHERE id = $1`, [id]);
      break;

    case 'reject':
      await query(
        `UPDATE portal_form_submissions
            SET resolved_status='rejected',
                completed_at = now(),
                acknowledged_at = COALESCE(acknowledged_at, now())
          WHERE id = $1`, [id]);
      break;

    case 'update_notes': {
      const notes = String(fd.get('admin_notes') ?? '').trim() || null;
      await query(
        `UPDATE portal_form_submissions SET admin_notes = $2 WHERE id = $1`,
        [id, notes]);
      break;
    }

    case 'reassign': {
      const to = String(fd.get('assigned_to_email') ?? '').trim().toLowerCase() || null;
      await query(
        `UPDATE portal_form_submissions SET assigned_to_email = $2 WHERE id = $1`,
        [id, to]);
      break;
    }

    default:
      return NextResponse.json({ error: 'unknown_action', detail: action }, { status: 400 });
  }

  const url = new URL(safeReturn, request.url);
  url.searchParams.set('msg', `Updated · ${action}`);
  return NextResponse.redirect(url, 303);
}
