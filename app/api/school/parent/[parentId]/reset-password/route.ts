// POST /api/school/parent/[parentId]/reset-password
//
// Operator/office self-serve portal-password reset. Generates a fresh
// temporary password, stores its hash on the parent row (overwriting any
// existing password), and returns the plaintext ONCE in the response so
// the operator can read it out / copy it to the parent. There is no email
// dependency — the whole point is to unblock a parent whose reset emails
// never arrive, which is why the portal's Help page says "contact the
// office" for a forgotten password. This is that office button.
//
// The parent then signs in at the portal with their email + this password
// (the password-signin route verifies against the hash we set here).
//
// Hashing MUST stay byte-compatible with the parent portal's
// lib/auth/password.ts: scrypt, 16-byte hex salt, 32-byte key, stored as
// "salt:hex". Verified: a hash produced here validates under that repo's
// verifyPassword().
//
// Auth: operator session OR a school session scoped to the parent's own
// school (no cross-school resets). Mirrors view-as-parent.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ parentId: string }>;

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(plain, salt, 32);
  return `${salt}:${buf.toString('hex')}`;
}

// Readable, unambiguous temp password: 4 letters + '-' + 4 digits, e.g.
// "KFMR-7392". Skips 0/O/1/I/L so a parent can't misread it over the phone.
// 24^4 * 8^4 ≈ 1.4B combinations — plenty for a short-lived temp secret.
function generateTempPassword(): string {
  const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
  const DIGITS = '23456789'; // no 0, 1
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const letters = Array.from({ length: 4 }, () => pick(LETTERS)).join('');
  const digits = Array.from({ length: 4 }, () => pick(DIGITS)).join('');
  return `${letters}-${digits}`;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { parentId } = await params;

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!isOperator && !schoolSession) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { rows } = await query<{
    id: string; school_id: string; family_id: string;
    email: string | null; first_name: string | null; last_name: string | null;
  }>(
    `SELECT id, school_id, family_id, email, first_name, last_name
       FROM parents WHERE id = $1 AND status = 'active'`,
    [parentId],
  );
  const parent = rows[0];
  if (!parent) {
    return NextResponse.json({ ok: false, error: 'parent_not_found' }, { status: 404 });
  }
  // School sessions can only reset their own school's parents.
  if (!isOperator && schoolSession && parent.school_id !== schoolSession.school_id) {
    return NextResponse.json({ ok: false, error: 'cross_school_blocked' }, { status: 403 });
  }
  // Sign-in keys on email — a passwordless-email parent can't use it anyway.
  if (!parent.email || !parent.email.trim()) {
    return NextResponse.json({ ok: false, error: 'parent_has_no_email' }, { status: 400 });
  }

  const password = generateTempPassword();
  const hash = await hashPassword(password);
  await query(
    `UPDATE parents SET password_hash = $1, password_set_at = now(), updated_at = now()
      WHERE id = $2`,
    [hash, parent.id],
  );

  // Best-effort audit trail — never block the reset on a logging failure.
  try {
    await query(
      `INSERT INTO parent_portal_audit_log (school_id, parent_id, family_id, event_type, detail)
       VALUES ($1, $2, $3, 'password_reset_admin', $4::jsonb)`,
      [parent.school_id, parent.id, parent.family_id,
       JSON.stringify({ by: isOperator ? 'operator' : 'school', email: parent.email })],
    );
  } catch {
    // ignore
  }

  return NextResponse.json({
    ok: true,
    password,
    email: parent.email,
    name: [parent.first_name, parent.last_name].filter(Boolean).join(' ').trim() || null,
  });
}
