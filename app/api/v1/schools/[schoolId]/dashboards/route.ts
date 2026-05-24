import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkServiceAuth, unauthorizedResponse } from '@/lib/auth/service';
import { listSchoolDashboards } from '@/lib/dashboards/loader';
import { dashboardRegistry } from '@/lib/dashboards/registry';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string }>;

// GET /api/v1/schools/{schoolId}/dashboards — list this school's dashboards
export async function GET(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId } = await params;
  const dashboards = await listSchoolDashboards(schoolId);
  return NextResponse.json({ dashboards });
}

// POST /api/v1/schools/{schoolId}/dashboards — assign one dashboard
// Body: { dashboard_slug, display_name?, description?, layout?, position? }
// If a row already exists for this (school, dashboard_slug), returns 409.
export async function POST(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId } = await params;

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }

  const slug = String(body.dashboard_slug ?? '').trim();
  if (!slug) return NextResponse.json({ error: 'dashboard_slug required' }, { status: 400 });

  const def = dashboardRegistry[slug];
  if (!def) return NextResponse.json({ error: `unknown dashboard slug: ${slug}` }, { status: 404 });

  const layout = Array.isArray(body.layout) ? body.layout : def.default_layout;
  const display_name = typeof body.display_name === 'string' ? body.display_name : def.display_name;
  const description = typeof body.description === 'string' ? body.description : def.description;
  const position = Number.isInteger(body.position) ? body.position : 0;

  try {
    const { rows } = await query(
      `INSERT INTO school_dashboards (school_id, dashboard_slug, display_name, description, layout, position)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [schoolId, slug, display_name, description, JSON.stringify(layout), position]
    );
    return NextResponse.json({ dashboard: rows[0] }, { status: 201 });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return NextResponse.json(
        { error: 'this school already has that dashboard assigned' },
        { status: 409 }
      );
    }
    throw err;
  }
}
