// School-facing save for school behavior settings (schools.settings jsonb):
// academic year, portal-access gate stage, auto Student IDs, Parent-2
// promotion, roster tag filter. School-scoped (school session OR operator).
// Merges into the existing settings bag so unknown keys survive.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';

type Params = Promise<{ locationId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const authorized = isOperator || (schoolSession && schoolSession.school_id === school.id);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const form = await request.formData();
    const str = (k: string) => String(form.get(k) ?? '').trim();

    const academicYear = str('academic_year');
    if (!/^\d{4}-\d{2}$/.test(academicYear)) {
      return back(request, locationId, { err: 'Academic year must look like 2026-27.' });
    }
    const patch = {
      academic_year: academicYear,
      // blank = ungated (any active parent can create a login)
      portal_gate_stage: str('portal_gate_stage') || null,
      auto_student_ids: form.get('auto_student_ids') === 'on',
      promote_parent2: form.get('promote_parent2') === 'on',
      roster_tag_filter: str('roster_tag_filter')
        .split(',').map((t) => t.trim()).filter(Boolean),
    };

    await query(
      `UPDATE schools SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1`,
      [school.id, JSON.stringify(patch)],
    );
    return back(request, locationId, { msg: 'School settings saved.' });
  } catch (err) {
    return back(request, locationId, { err: `Save failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function back(request: NextRequest, locationId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/school/${locationId}/settings`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
