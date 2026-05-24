// Save free-form operator notes on a dp_donors row. Called from the
// DonorDashboard accordion's inline notes editor inside the school
// iframe. Authed via the school session cookie (matches /school/*
// gate). school_id is read from the cookie so the operator can't
// accidentally write notes on another school's donor.
//
// DonorPerfect imports MUST NOT touch the school_notes column —
// this is the persistence boundary between operator edits and source
// data.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Cap to avoid runaway text — way more than any reasonable operator
// note. If anyone hits this, they're pasting an entire history into
// the wrong field.
const MAX_NOTES_LENGTH = 50_000;

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const fd = await request.formData();
  const dpDonorId = String(fd.get('dp_donor_id') ?? '').trim();
  const notes = String(fd.get('notes') ?? '');
  if (!dpDonorId) {
    return new NextResponse('missing dp_donor_id', { status: 400 });
  }
  if (notes.length > MAX_NOTES_LENGTH) {
    return new NextResponse(`notes too long (max ${MAX_NOTES_LENGTH} chars)`, { status: 413 });
  }

  // Empty string → NULL so "no notes" reads as missing not as a blank cell
  const value = notes.trim() === '' ? null : notes;

  const result = await query(
    `UPDATE dp_donors
        SET school_notes = $1,
            school_notes_updated_at = now(),
            school_notes_updated_by = $2
      WHERE school_id = $3 AND dp_donor_id = $4`,
    [value, session.user_email ?? null, session.school_id, dpDonorId],
  );

  if (result.rowCount === 0) {
    return new NextResponse('donor not found', { status: 404 });
  }

  return NextResponse.json({ ok: true, saved_at: new Date().toISOString() });
}
