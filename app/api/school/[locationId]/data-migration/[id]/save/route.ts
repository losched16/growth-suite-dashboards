// POST /api/school/{locationId}/data-migration/{id}/save
// Save operator mapping overrides. Form fields: target__<csv_column> = target_key
// (empty or '__skip__' unmaps the column). Read-only w.r.t. GHL.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import { applyOverrides, type MappingRow } from '@/lib/migration/csv-mapping';
import { loadMigrationTargets } from '@/lib/migration/targets';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId, id } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });
  const auth = await authorizeOperatorOrSchool(school.id);
  if (!auth.ok) return auth.response;

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/school/${locationId}/data-migration/${id}`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  try {
    const { rows } = await query<{ mapping: MappingRow[] }>(
      `SELECT mapping FROM csv_migrations WHERE id = $1 AND school_id = $2`, [id, school.id]);
    if (rows.length === 0) return back({ err: 'That migration no longer exists.' });

    const form = await request.formData();
    const overrides: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (k.startsWith('target__')) overrides[k.slice('target__'.length)] = String(v);
    }

    const targets = await loadMigrationTargets(school.id);
    const nextMapping = applyOverrides(rows[0].mapping, overrides, targets);
    await query(
      `UPDATE csv_migrations SET mapping = $3::jsonb, status = 'reviewed', updated_at = now()
        WHERE id = $1 AND school_id = $2`,
      [id, school.id, JSON.stringify(nextMapping)]);
    return back({ msg: 'Mapping saved.' });
  } catch (err) {
    return back({ err: `Save failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
