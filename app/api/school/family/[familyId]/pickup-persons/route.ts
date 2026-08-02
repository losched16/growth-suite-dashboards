// POST /api/school/family/{familyId}/pickup-persons — office-side
// pickup-person management. DGM policy: parents can't self-add pickup
// people (they email admissions); this is where the office lands those
// requests. Actions (FormData `action`):
//   create      name, relationship, phone?, notes?, authorized_student_ids*
//               → inserts the person AND generates their kiosk PIN.
//               Returns { ok, id, pin } — the PIN is shown ONCE.
//   set_pin     id → regenerates the PIN. Returns { ok, pin }.
//   deactivate  id → active=false (row kept; history stays intact).
//   reactivate  id → active=true.
//
// Auth: school OR operator session — same posture as the family detail
// route this UI lives next to.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { generatePin, hashPin, pinLookup } from '@/lib/attendance/pickup-pin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ familyId: string }>;

// School-wide uniqueness: a PIN identifies ONE person at the kiosk.
async function uniquePin(schoolId: string): Promise<{ pin: string; lookup: string }> {
  for (let i = 0; i < 25; i++) {
    const pin = generatePin();
    const lookup = pinLookup(schoolId, pin);
    const { rows } = await query<{ n: number }>(
      `SELECT (SELECT count(*) FROM parents WHERE school_id = $1 AND pin_lookup = $2)
            + (SELECT count(*) FROM pickup_persons WHERE school_id = $1 AND pin_lookup = $2) AS n`,
      [schoolId, lookup],
    );
    if (Number(rows[0].n) === 0) return { pin, lookup };
  }
  throw new Error('could not find a free PIN');
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { familyId } = await params;
  const ck = await cookies();
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const operatorSession = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  if (!schoolSession && !operatorSession) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { rows: famRows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM families WHERE id = $1`,
    [familyId],
  );
  const family = famRows[0];
  if (!family) return NextResponse.json({ ok: false, error: 'family_not_found' }, { status: 404 });

  const fd = await request.formData();
  const action = String(fd.get('action') ?? '').trim();

  if (action === 'create') {
    const name = String(fd.get('name') ?? '').trim();
    const relationship = String(fd.get('relationship') ?? '').trim();
    const phone = String(fd.get('phone') ?? '').trim() || null;
    const notes = String(fd.get('notes') ?? '').trim() || null;
    if (!name || !relationship) {
      return NextResponse.json({ ok: false, error: 'name and relationship are required' }, { status: 400 });
    }

    // added_by is NOT NULL and references parents — attribute office
    // adds to the family's primary parent (the requester, in practice).
    const { rows: pRows } = await query<{ id: string }>(
      `SELECT id FROM parents WHERE family_id = $1 AND status = 'active'
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      [familyId],
    );
    if (!pRows[0]) return NextResponse.json({ ok: false, error: 'family has no active parent' }, { status: 400 });

    // Optional per-student scoping — ids must belong to this family.
    const requestedIds = fd.getAll('authorized_student_ids').map(String).filter(Boolean);
    let studentIds: string[] = [];
    if (requestedIds.length > 0) {
      const { rows: sRows } = await query<{ id: string }>(
        `SELECT id FROM students WHERE family_id = $1 AND id = ANY($2::uuid[])`,
        [familyId, requestedIds],
      );
      studentIds = sRows.map((r) => r.id);
    }

    const { pin, lookup } = await uniquePin(family.school_id);
    const pinHash = await hashPin(pin);
    const { rows: ins } = await query<{ id: string }>(
      `INSERT INTO pickup_persons
         (school_id, family_id, added_by_parent_id, name, relationship, phone, notes,
          active, pin_hash, pin_lookup, pin_set_at, is_temporary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, now(), false)
       RETURNING id`,
      [family.school_id, familyId, pRows[0].id, name, relationship, phone, notes, pinHash, lookup],
    );
    const personId = ins[0].id;
    for (const sid of studentIds) {
      await query(
        `INSERT INTO pickup_person_students (pickup_person_id, student_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [personId, sid],
      );
    }
    return NextResponse.json({ ok: true, id: personId, pin });
  }

  // Remaining actions operate on an existing person of THIS family.
  const id = String(fd.get('id') ?? '').trim();
  const { rows: ppRows } = await query<{ id: string }>(
    `SELECT id FROM pickup_persons WHERE id = $1 AND family_id = $2 AND school_id = $3`,
    [id, familyId, family.school_id],
  );
  if (!ppRows[0]) return NextResponse.json({ ok: false, error: 'pickup_person_not_found' }, { status: 404 });

  if (action === 'set_pin') {
    const { pin, lookup } = await uniquePin(family.school_id);
    const pinHash = await hashPin(pin);
    await query(
      `UPDATE pickup_persons
          SET pin_hash = $2, pin_lookup = $3, pin_set_at = now(), pin_expires_at = NULL
        WHERE id = $1`,
      [id, pinHash, lookup],
    );
    return NextResponse.json({ ok: true, pin });
  }

  if (action === 'deactivate' || action === 'reactivate') {
    await query(`UPDATE pickup_persons SET active = $2 WHERE id = $1`, [id, action === 'reactivate']);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
}
