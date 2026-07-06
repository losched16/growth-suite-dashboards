// POST /api/school/{locationId}/data-catalog/surface
//
// Marks which DISCOVERED fields/tags the school has chosen to "use" (surfaced).
// Surfacing is the school's decision — discovery only makes an item AVAILABLE;
// this records that they want it, and clears it from the "N new items" prompt.
// Writes only our catalog tables' `surfaced` flag. Operator OR matching school
// session.

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
  if (!(isOperator || (schoolSession && schoolSession.school_id === school.id))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/school/${locationId}/data-catalog`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  try {
    const form = await request.formData();
    // The form submits every candidate key/tag as a hidden "all_*" field, and
    // the checked ones as "field"/"tag". Surfaced = checked; everything else in
    // the candidate set is cleared. Core fields aren't candidates (always used).
    const allFields = String(form.get('all_fields') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const allTags = String(form.get('all_tags') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    const checkedFields = new Set(form.getAll('field').map((v) => String(v)));
    const checkedTags = new Set(form.getAll('tag').map((v) => String(v)));

    for (const key of allFields) {
      await query(
        `UPDATE school_field_catalog SET surfaced = $3, updated_at = now()
          WHERE school_id = $1 AND field_key = $2`,
        [school.id, key, checkedFields.has(key)]);
    }
    for (const tag of allTags) {
      await query(
        `UPDATE school_tag_catalog SET surfaced = $3
          WHERE school_id = $1 AND tag = $2`,
        [school.id, tag, checkedTags.has(tag)]);
    }
    const n = checkedFields.size + checkedTags.size;
    return back({ msg: `Saved — ${n} item${n === 1 ? '' : 's'} marked for use. Add them as columns/filters from Customize roster.` });
  } catch (err) {
    return back({ err: `Save failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
