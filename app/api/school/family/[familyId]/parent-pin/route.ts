// POST /api/school/family/{familyId}/parent-pin — office sets a
// PARENT's kiosk PIN on their behalf (phone request: "make my PIN
// 4482"). Writes exactly what the portal's my-pin route writes —
// scrypt hash + HMAC lookup + encrypted viewable copy — so the PIN
// works at the kiosk immediately and displays both on this roster
// panel and in the parent's own portal.
//
// Body (FormData): parent_id, pin (4-8 digits, same rules as the
// portal: no trivial PINs, school-wide unique).
// Auth: school OR operator session — same posture as the family
// detail route this UI lives in.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { hashPin, pinLookup, validateChosenPin } from '@/lib/attendance/pickup-pin';
import { encrypt } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ familyId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { familyId } = await params;
  const ck = await cookies();
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const operatorSession = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  if (!schoolSession && !operatorSession) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const fd = await request.formData();
  const parentId = String(fd.get('parent_id') ?? '').trim();
  const pin = String(fd.get('pin') ?? '').trim();

  const { rows: pRows } = await query<{ id: string; school_id: string }>(
    `SELECT id, school_id FROM parents WHERE id = $1 AND family_id = $2 AND status = 'active'`,
    [parentId, familyId],
  );
  const parent = pRows[0];
  if (!parent) return NextResponse.json({ ok: false, error: 'parent_not_found' }, { status: 404 });

  const problem = validateChosenPin(pin);
  if (problem) return NextResponse.json({ ok: false, error: 'invalid_pin', detail: problem }, { status: 400 });

  const lookup = pinLookup(parent.school_id, pin);
  const { rows: clash } = await query<{ n: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM parents
         WHERE school_id = $1 AND pin_lookup = $2 AND id <> $3)
       +
       (SELECT COUNT(*) FROM pickup_persons
         WHERE school_id = $1 AND pin_lookup = $2 AND active = true)
     )::text AS n`,
    [parent.school_id, lookup, parent.id],
  );
  if (Number(clash[0]?.n ?? 0) > 0) {
    return NextResponse.json({
      ok: false,
      error: 'pin_taken',
      detail: 'That PIN is already in use at this school — pick a different one.',
    }, { status: 409 });
  }

  const hash = await hashPin(pin);
  const enc = encrypt(pin);
  await query(
    `UPDATE parents
        SET pin_hash = $2, pin_lookup = $3, pin_set_at = now(), updated_at = now(),
            pin_encrypted = $4, pin_iv = $5, pin_tag = $6
      WHERE id = $1`,
    [parent.id, hash, lookup, enc.ciphertext, enc.iv, enc.tag],
  );

  return NextResponse.json({ ok: true, pin });
}
