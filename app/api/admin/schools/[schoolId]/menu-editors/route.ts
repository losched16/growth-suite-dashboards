// GET  /api/admin/schools/[schoolId]/menu-editors      → list
// POST /api/admin/schools/[schoolId]/menu-editors      → add { email, name? }
// DELETE /api/admin/schools/[schoolId]/menu-editors    → remove ?id=<uuid>
//
// Operator-only — uses the same hmac-signed cookie the rest of the
// /admin pages already check. No teacher cookie required here.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

async function requireOperator(): Promise<boolean> {
  const ck = await cookies();
  return verifySessionToken(ck.get(SESSION_COOKIE)?.value);
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  if (!(await requireOperator())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { schoolId } = await params;

  const { rows } = await query<{ id: string; email: string; name: string | null; created_at: Date }>(
    `SELECT id, email, name, created_at
       FROM school_menu_editors
      WHERE school_id = $1
      ORDER BY created_at`,
    [schoolId],
  );
  return NextResponse.json({ editors: rows });
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  if (!(await requireOperator())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { schoolId } = await params;

  const body = await request.json().catch(() => null) as { email?: string; name?: string } | null;
  if (!body) return NextResponse.json({ error: 'bad_body' }, { status: 400 });
  const email = (body.email ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim() || null;
  if (!looksLikeEmail(email)) return NextResponse.json({ error: 'bad_email' }, { status: 400 });

  await query(
    `INSERT INTO school_menu_editors (school_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (school_id, email) DO UPDATE SET name = COALESCE(EXCLUDED.name, school_menu_editors.name)`,
    [schoolId, email, name],
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  if (!(await requireOperator())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { schoolId } = await params;
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }
  await query(
    `DELETE FROM school_menu_editors WHERE id = $1 AND school_id = $2`,
    [id, schoolId],
  );
  return NextResponse.json({ ok: true });
}
