// Office-side management of a family's authorized pickup people.
// Needed since parent_managed_pickups=false schools (DGM) route every
// addition through the office — this is the office's door.
//
//   POST                   → add (family_id, name, relationship, phone?, notes?)
//   POST ?_method=DELETE   → deactivate (id)
//
// Auth: school session (same contract as the submission void route).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const dynamic = 'force-dynamic';

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const to = String(params.return_to ?? '').trim() || '/';
  const url = new URL(to, request.url);
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'return_to' && v) url.searchParams.set(k, v);
  }
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData();
  const returnTo = String(fd.get('return_to') ?? '').trim();
  const method = (request.nextUrl.searchParams.get('_method') ?? '').toUpperCase();

  if (method === 'DELETE') {
    const id = String(fd.get('id') ?? '');
    await query(
      `UPDATE pickup_persons SET active = false, updated_at = now()
        WHERE id = $1 AND school_id = $2`,
      [id, session.school_id],
    );
    return back(request, { return_to: returnTo, msg: 'Pickup person deactivated.' });
  }

  const familyId = String(fd.get('family_id') ?? '');
  const name = String(fd.get('name') ?? '').trim();
  const relationship = String(fd.get('relationship') ?? '').trim();
  const phone = String(fd.get('phone') ?? '').trim() || null;
  const notes = String(fd.get('notes') ?? '').trim() || null;
  if (!familyId || !name || !relationship) {
    return back(request, { return_to: returnTo, err: 'Name and relationship are required.' });
  }

  // added_by is NOT NULL → attribute office adds to the family's primary
  // parent (the row exists for every family; the UI labels office adds).
  const { rows: pri } = await query<{ id: string }>(
    `SELECT p.id FROM parents p JOIN families f ON f.id = p.family_id
      WHERE p.family_id = $1 AND f.school_id = $2 AND p.is_primary = true LIMIT 1`,
    [familyId, session.school_id],
  );
  if (!pri[0]) return back(request, { return_to: returnTo, err: 'Family not found.' });

  await query(
    `INSERT INTO pickup_persons (school_id, family_id, added_by_parent_id, name, relationship, phone, notes, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
    [session.school_id, familyId, pri[0].id, name, relationship, phone, notes ? `${notes} (added by office)` : '(added by office)'],
  );
  return back(request, { return_to: returnTo, msg: `${name} added to the authorized list.` });
}
