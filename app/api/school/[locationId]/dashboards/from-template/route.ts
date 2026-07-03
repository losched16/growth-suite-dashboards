// POST /api/school/{locationId}/dashboards/from-template
// Body (form): template=<key>
//
// Creates the dashboard(s) for a prebuilt template (lib/dashboards/templates).
// School-scoped auth (school session OR operator). Existing slugs are left
// untouched, so re-adding a template only fills in what's missing — safe to
// re-run (e.g. classroom-hubs after a new classroom appears in GHL).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadSchoolSettings } from '@/lib/school-settings';
import { DASHBOARD_TEMPLATES } from '@/lib/dashboards/templates';
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

  const form = await request.formData().catch(() => null);
  const key = String(form?.get('template') ?? '').trim();
  const template = DASHBOARD_TEMPLATES.find((t) => t.key === key);
  if (!template) return back(request, locationId, { err: 'Unknown template.' });

  try {
    const settings = await loadSchoolSettings(school.id);
    const dashboards = await template.build(school.id, settings.academic_year);
    if (dashboards.length === 0) {
      return back(request, locationId, { err: 'Nothing to create — e.g. no classrooms with enrolled students yet.' });
    }

    const { rows: existing } = await query<{ dashboard_slug: string; p: number }>(
      `SELECT dashboard_slug, COALESCE(MAX(position) OVER (), 0)::int AS p
         FROM school_dashboards WHERE school_id = $1`,
      [school.id],
    );
    const have = new Set(existing.map((r) => r.dashboard_slug));
    let position = existing[0]?.p ?? 0;

    let created = 0;
    for (const d of dashboards) {
      if (have.has(d.dashboard_slug)) continue;
      position++;
      await query(
        `INSERT INTO school_dashboards (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)`,
        [school.id, d.dashboard_slug, d.display_name, d.description, JSON.stringify(d.layout), position],
      );
      created++;
    }
    const skipped = dashboards.length - created;
    return back(request, locationId, {
      msg: `${template.title}: ${created} dashboard${created === 1 ? '' : 's'} created${skipped ? ` (${skipped} already existed)` : ''}.`,
    });
  } catch (err) {
    return back(request, locationId, { err: `Create failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function back(request: NextRequest, locationId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/school/${locationId}/dashboards/new`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
