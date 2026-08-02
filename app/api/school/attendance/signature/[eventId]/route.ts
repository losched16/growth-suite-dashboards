// GET /api/school/attendance/signature/{eventId}
//
// Serves the signature image captured on an attendance event (kiosk or
// portal check-in/out). Auth: school session for the event's school OR
// a valid embed token — same posture as the attendance-history page
// that links here.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ eventId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { eventId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }

  const { rows } = await query<{ signature_png: string | null; school_id: string; ghl_location_id: string | null }>(
    `SELECT ae.signature_png, ae.school_id, s.ghl_location_id
       FROM attendance_events ae JOIN schools s ON s.id = ae.school_id
      WHERE ae.id = $1`,
    [eventId],
  );
  const ev = rows[0];
  if (!ev) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const sessionOk = !!session && session.school_id === ev.school_id;
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  const embedOk = !!embedToken && !!ev.ghl_location_id && checkEmbedToken(ev.ghl_location_id, embedToken);
  if (!sessionOk && !embedOk) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(ev.signature_png ?? '');
  if (!m) return NextResponse.json({ error: 'no_signature' }, { status: 404 });

  return new NextResponse(Buffer.from(m[2], 'base64'), {
    status: 200,
    headers: {
      'Content-Type': m[1],
      'Cache-Control': 'private, max-age=300',
    },
  });
}
