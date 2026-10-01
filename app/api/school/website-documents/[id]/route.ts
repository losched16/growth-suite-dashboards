// PATCH  /api/school/website-documents/{id} — rename a card, move it to a
//        different month or section, publish or unpublish it.
// DELETE /api/school/website-documents/{id} — remove it, bytes and all.
//
// Both scope every statement by the school_id on the session cookie, so an
// id belonging to another school simply reads as not found.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

function monthOf(v: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }

  let body: { label?: string; section?: string; month?: string | null; is_published?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }); }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  if (typeof body.label === 'string') {
    const label = body.label.trim().slice(0, 120);
    if (!label) return NextResponse.json({ error: 'A name is required.' }, { status: 400 });
    put('label', label);
  }
  if (typeof body.section === 'string') {
    const s = body.section.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    if (!s) return NextResponse.json({ error: 'bad_section' }, { status: 400 });
    put('section', s);
  }
  if (body.month !== undefined) {
    if (body.month === null || body.month === '') {
      put('period_month', null);
    } else {
      const period = monthOf(String(body.month));
      if (!period) return NextResponse.json({ error: 'Month must look like 2026-08.' }, { status: 400 });
      put('period_month', period);
    }
  }
  if (typeof body.is_published === 'boolean') put('is_published', body.is_published);

  if (sets.length === 0) return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });

  vals.push(id, session.school_id);
  const { rows } = await query<{
    id: string; section: string; label: string; period_month: string | null; is_published: boolean;
  }>(
    `UPDATE website_documents
        SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${vals.length - 1} AND school_id = $${vals.length}
      RETURNING id, section, label, to_char(period_month, 'YYYY-MM-DD') AS period_month, is_published`,
    vals,
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({ document: rows[0] });
}

export async function DELETE(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400 });
  }

  const { rows } = await query<{ id: string }>(
    `DELETE FROM website_documents WHERE id = $1 AND school_id = $2 RETURNING id`,
    [id, session.school_id],
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
