// POST /api/school/roster-settings
//
// Saves the school's self-serve filter/column picks onto the
// student_roster_rich widget config in school_dashboards.layout.
// Body: { school_id, extra_filters: string[], extra_columns: string[] }
//
// attr_keys are validated against the school's filter catalog so junk
// keys can't land in the config. Auth posture matches the other
// embedded /school config endpoints (light — the GHL iframe's cookie
// state is unreliable; the school_id scoping + catalog validation is
// the real guard).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  school_id?: string;
  extra_filters?: unknown;
  extra_columns?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.school_id) return NextResponse.json({ error: 'school_id required' }, { status: 400 });
  const schoolId = body.school_id;

  const wanted = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).filter((s) => s.length > 0 && s.length < 200).slice(0, 100) : [];
  const reqFilters = wanted(body.extra_filters);
  const reqColumns = wanted(body.extra_columns);

  // Validate against the catalog — only real attributes are saved.
  const { rows: cat } = await query<{ attr_key: string }>(
    `SELECT attr_key FROM school_filter_catalog WHERE school_id = $1`,
    [schoolId],
  );
  const valid = new Set(cat.map((c) => c.attr_key));
  const extraFilters = reqFilters.filter((k) => valid.has(k));
  const extraColumns = reqColumns.filter((k) => valid.has(k));

  // Load + update the student-roster widget config in place.
  const { rows } = await query<{ layout: Array<{ widget_id: string; config: Record<string, unknown> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
    [schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no_roster_dashboard', detail: 'This school has no student-roster dashboard provisioned.' }, { status: 404 });
  }
  const layout = rows[0].layout;
  let touched = false;
  for (const w of layout) {
    if (w.widget_id === 'student_roster_rich') {
      w.config = { ...w.config, extra_filters: extraFilters, extra_columns: extraColumns };
      touched = true;
    }
  }
  if (!touched) {
    return NextResponse.json({ error: 'no_roster_widget', detail: 'student_roster_rich widget not found on the roster dashboard.' }, { status: 404 });
  }

  await query(
    `UPDATE school_dashboards SET layout = $2::jsonb, updated_at = now()
      WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
    [schoolId, JSON.stringify(layout)],
  );

  return NextResponse.json({
    ok: true,
    extra_filters: extraFilters,
    extra_columns: extraColumns,
    dropped: [...reqFilters, ...reqColumns].filter((k) => !valid.has(k)),
  });
}
