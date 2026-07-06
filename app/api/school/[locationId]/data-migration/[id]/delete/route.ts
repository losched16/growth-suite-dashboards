// POST /api/school/{locationId}/data-migration/{id}/delete
// Remove an uploaded migration (and its stored rows). No GHL effect.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; id: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const { locationId, id } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });
  const auth = await authorizeOperatorOrSchool(school.id);
  if (!auth.ok) return auth.response;

  await query(`DELETE FROM csv_migrations WHERE id = $1 AND school_id = $2`, [id, school.id]);
  const url = new URL(`/school/${locationId}/data-migration`, _request.nextUrl.origin);
  url.searchParams.set('msg', 'Migration deleted.');
  return NextResponse.redirect(url, 303);
}
