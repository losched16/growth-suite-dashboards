// POST /api/admin/schools/{schoolId}/staff — manage staff sign-in list.
//   op=add     email, name?, role?   → upsert active staff row
//   op=remove  staff_id              → set inactive (links stop working)
// Operator-namespace; redirects back to the staff page.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}/staff`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const fd = await request.formData();
  const op = String(fd.get('op') ?? '').trim();

  if (op === 'add') {
    const email = String(fd.get('email') ?? '').trim().toLowerCase();
    const name = String(fd.get('name') ?? '').trim() || null;
    const role = ['admin', 'staff'].includes(String(fd.get('role'))) ? String(fd.get('role')) : 'admin';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return back(request, schoolId, { err: 'Enter a valid email.' });
    }
    await query(
      `INSERT INTO school_staff (school_id, email, name, role, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (school_id, lower(email)) DO UPDATE
         SET name = COALESCE(EXCLUDED.name, school_staff.name),
             role = EXCLUDED.role, status = 'active', updated_at = now()`,
      [schoolId, email, name, role],
    );
    return back(request, schoolId, { msg: `${email} can now sign in at /staff.` });
  }

  if (op === 'remove') {
    const staffId = String(fd.get('staff_id') ?? '').trim();
    await query(
      `UPDATE school_staff SET status = 'inactive', updated_at = now()
        WHERE id = $1 AND school_id = $2`,
      [staffId, schoolId],
    );
    return back(request, schoolId, { msg: 'Staff access removed.' });
  }

  return back(request, schoolId, { err: 'Unknown operation.' });
}
