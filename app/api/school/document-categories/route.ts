// GET  /api/school/document-categories
//   Returns the category list for the session's school. Sorted by
//   sort_order then label so the dropdown is deterministic.
//
// POST /api/school/document-categories
//   { label: string }  → creates a new category. Slugifies label →
//   `key` so the back-end stays clean. Idempotent on (school_id, key)
//   so a teacher re-creating "IEP Goals" doesn't error.
//
// Auth: any valid school session. We don't gate creation to operator-
// only — teachers uploading need to be able to spin up a new category
// inline when the existing list doesn't fit.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity } from '@/lib/auth/teacher-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CategoryRow { id: string; key: string; label: string; sort_order: number }

function slugifyKey(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

export async function GET() {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows } = await query<CategoryRow>(
    `SELECT id, key, label, sort_order
       FROM school_document_categories
      WHERE school_id = $1
      ORDER BY sort_order, label`,
    [session.school_id],
  );
  return NextResponse.json({ categories: rows });
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null) as { label?: string } | null;
  if (!body || typeof body.label !== 'string' || !body.label.trim()) {
    return NextResponse.json({ error: 'bad_label' }, { status: 400 });
  }
  const label = body.label.trim().slice(0, 80);
  const key = slugifyKey(label);
  if (!key) return NextResponse.json({ error: 'unmappable_label' }, { status: 400 });

  // Teacher email lands in created_by so an operator looking at the
  // categories table can audit who's added what.
  const teacher = await getTeacherIdentity();
  const createdBy = teacher?.email ?? null;

  const { rows } = await query<CategoryRow>(
    `INSERT INTO school_document_categories (school_id, key, label, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id, key) DO UPDATE SET label = EXCLUDED.label
     RETURNING id, key, label, sort_order`,
    [session.school_id, key, label, createdBy],
  );
  return NextResponse.json({ category: rows[0] });
}
