// POST /api/school/{locationId}/data-migration/{id}/apply
// ⚠️ LIVE GHL WRITE — hard-gated by CSV_MIGRATION_ALLOW_LOCATIONS (see
// lib/migration/apply-to-ghl.ts). If the school's location isn't allow-listed,
// this refuses and writes nothing. Optional form field `limit` caps rows for a
// small first-run smoke test.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import type { MappingRow } from '@/lib/migration/csv-mapping';
import { applyMigrationToGhl, commitAllowedFor } from '@/lib/migration/apply-to-ghl';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

  // Hard gate: the URL's locationId IS the GHL location id.
  if (!commitAllowedFor(locationId)) {
    return back({ err: 'Applying to GHL is disabled for this account. It runs only where an administrator has explicitly enabled it (allow-list). The mapping + dry-run preview are unaffected.' });
  }

  try {
    const { rows } = await query<{ rows: Array<Record<string, string>>; mapping: MappingRow[] }>(
      `SELECT rows, mapping FROM csv_migrations WHERE id = $1 AND school_id = $2`, [id, school.id]);
    if (rows.length === 0) return back({ err: 'That migration no longer exists.' });

    const form = await request.formData();
    const limitRaw = Number(form.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;

    const result = await applyMigrationToGhl(school.id, rows[0].rows, rows[0].mapping, { limit });
    await query(
      `UPDATE csv_migrations SET status = 'applied', applied_at = now(), applied_summary = $3::jsonb, updated_at = now()
        WHERE id = $1 AND school_id = $2`,
      [id, school.id, JSON.stringify({ attempted: result.attempted, created: result.created, updated: result.updated, errors: result.errors })]);

    const errNote = result.errors > 0 ? ` (${result.errors} errored — see below)` : '';
    return back({ msg: `Applied: ${result.created} created, ${result.updated} updated of ${result.attempted} rows${errNote}.` });
  } catch (err) {
    return back({ err: `Apply failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
