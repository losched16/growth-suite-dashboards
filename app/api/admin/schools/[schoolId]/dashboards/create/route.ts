// POST create-dashboard: makes a new empty (or pre-populated) dashboard
// for the school. The slug becomes the URL fragment under /school/.../{slug}.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ schoolId: string }>;

const SLUG_RE = /^[a-z0-9-]+$/;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  try {
    const form = await request.formData();
    const display_name = String(form.get('display_name') ?? '').trim();
    let dashboard_slug = String(form.get('dashboard_slug') ?? '').trim().toLowerCase();
    const description = String(form.get('description') ?? '').trim() || null;

    if (!display_name) return back(request, schoolId, { err: 'Display name is required.' });

    // Auto-derive slug from display name if not provided
    if (!dashboard_slug) {
      dashboard_slug = display_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
    if (!SLUG_RE.test(dashboard_slug)) {
      return back(request, schoolId, {
        err: 'Slug must be lowercase letters, numbers, and hyphens only.',
      });
    }

    // Next available position
    const { rows: posRows } = await query<{ next_pos: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
       FROM school_dashboards WHERE school_id = $1`,
      [schoolId],
    );
    const position = posRows[0]?.next_pos ?? 0;

    const { rows, rowCount } = await query<{ id: string }>(
      `INSERT INTO school_dashboards
         (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, true, $5)
       ON CONFLICT (school_id, dashboard_slug) DO NOTHING
       RETURNING id`,
      [schoolId, dashboard_slug, display_name, description, position],
    );

    if (rowCount === 0) {
      return back(request, schoolId, {
        err: `A dashboard with slug "${dashboard_slug}" already exists.`,
      });
    }

    // Redirect into the new dashboard's editor so the operator can add widgets
    const url = request.nextUrl.clone();
    url.pathname = `/admin/${schoolId}/dashboard/${rows[0].id}`;
    url.search = '';
    url.searchParams.set('msg', `Created "${display_name}". Add widgets below.`);
    return NextResponse.redirect(url, 303);
  } catch (err) {
    return back(request, schoolId, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
