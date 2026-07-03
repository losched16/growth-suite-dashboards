// GET /api/ghl-menu-config/{locationId} — which CRM sidebar items to hide
// for this sub-account. Consumed by the agency-level Custom JS snippet
// (docs/ghl-menu-snippet.js) running inside the white-labeled GHL app, so it
// must be public + CORS-open. Menu visibility is cosmetic/non-sensitive; the
// response leaks nothing but a list of menu ids.
//
// Unknown locations return an empty hide-list (snippet shows everything),
// so the snippet is safe to install agency-wide before every sub-account is
// onboarded as a school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { normalizeSchoolSettings } from '@/lib/school-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  // Let the browser cache per-location config briefly so SPA navigation
  // doesn't hammer the endpoint; the snippet also caches per session.
  'Cache-Control': 'public, max-age=300',
};

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  try {
    const { rows } = await query<{ settings: unknown }>(
      `SELECT settings FROM schools WHERE ghl_location_id = $1`,
      [locationId],
    );
    const hide = rows.length ? normalizeSchoolSettings(rows[0].settings).ghl_hidden_menu : [];
    return NextResponse.json({ hide }, { headers: CORS });
  } catch {
    return NextResponse.json({ hide: [] }, { headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
