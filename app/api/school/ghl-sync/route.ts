// POST /api/school/ghl-sync — on-demand "Sync now" for a school.
//
// Runs the same pipeline as the 6-hour cron for one school: pulls
// every contact's tags + custom fields + opportunities from Growth
// Suite, refreshes the attribute layer, and propagates per-student
// slot fields into students.metadata. Lets an operator see a contact
// edit on the dashboards immediately instead of waiting for the cron.
//
// Embedded-iframe friendly (no session requirement — same posture as
// the other /api/school endpoints); scope comes from resolving the
// posted location_id to a school. Non-destructive by construction:
// the attribute sync never touches families/students/parents rows,
// and metadata propagation only overlays non-empty field values.
//
// Cheap debounce: if the school's field values were synced within the
// last 2 minutes, skip the GHL scan and report "already fresh" —
// keeps double-clicks and impatient operators from stacking scans.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { syncGhlAttributes } from '@/lib/sync/ghl-attributes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let locationId = '';
  try {
    const body = await request.json() as { location_id?: string };
    locationId = String(body.location_id ?? '').trim();
  } catch { /* fall through to 400 */ }
  if (!locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 });
  }

  const { rows: schools } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE ghl_location_id = $1 LIMIT 1`,
    [locationId],
  );
  const school = schools[0];
  if (!school) {
    return NextResponse.json({ error: 'unknown location' }, { status: 404 });
  }

  const { rows: fresh } = await query<{ recent: boolean }>(
    `SELECT COALESCE(MAX(synced_at) > now() - interval '2 minutes', false) AS recent
       FROM ghl_contact_field_values WHERE school_id = $1`,
    [school.id],
  );
  if (fresh[0]?.recent) {
    return NextResponse.json({ ok: true, skipped: 'recently_synced' });
  }

  try {
    const r = await syncGhlAttributes(school.id);
    return NextResponse.json({
      ok: true,
      contacts: r.contacts,
      field_values: r.field_value_rows,
      students_updated: r.student_metadata_updated,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error('[ghl-sync] on-demand sync failed for', school.name, ':', m);
    return NextResponse.json({ error: `Sync failed: ${m}` }, { status: 500 });
  }
}
