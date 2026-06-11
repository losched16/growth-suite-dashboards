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
import { AVAILABLE_COLUMNS, AVAILABLE_FILTERS, DETAIL_SECTIONS } from '@/lib/widgets/components/StudentRosterRich/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  school_id?: string;
  extra_filters?: unknown;
  extra_columns?: unknown;
  // Built-in roster columns/filters (ordered). Optional — only updated
  // when provided, so older callers stay compatible.
  shown_columns?: unknown;
  shown_filters?: unknown;
  // Row-dropdown customization: catalog attrs shown as extra detail
  // rows + which built-in sections render.
  detail_attrs?: unknown;
  detail_sections?: unknown;
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

  // Built-in toggles: validate against the widget's known keys. Only
  // applied when the body includes them (arrays). A school turning
  // everything off is allowed for filters, but we require at least one
  // column so the table can't render headerless.
  const validCols = new Set(AVAILABLE_COLUMNS.map((c) => c.key as string));
  const validFils = new Set(AVAILABLE_FILTERS.map((f) => f.key as string));
  const shownColumns = Array.isArray(body.shown_columns)
    ? body.shown_columns.map(String).filter((k) => validCols.has(k)).slice(0, 50)
    : null;
  const shownFilters = Array.isArray(body.shown_filters)
    ? body.shown_filters.map(String).filter((k) => validFils.has(k)).slice(0, 50)
    : null;
  if (shownColumns !== null && shownColumns.length === 0) {
    return NextResponse.json({ error: 'need_one_column', detail: 'Keep at least one column on.' }, { status: 400 });
  }

  // Row-dropdown picks. detail_attrs validated against the catalog;
  // detail_sections against the known built-in section keys. Empty
  // arrays are allowed (a school may strip the dropdown bare).
  const detailAttrs = Array.isArray(body.detail_attrs)
    ? body.detail_attrs.map(String).filter((k) => valid.has(k)).slice(0, 50)
    : null;
  const validSections = new Set<string>(DETAIL_SECTIONS.map((s) => s.key));
  const detailSections = Array.isArray(body.detail_sections)
    ? body.detail_sections.map(String).filter((k) => validSections.has(k)).slice(0, 20)
    : null;

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
      w.config = {
        ...w.config,
        extra_filters: extraFilters,
        extra_columns: extraColumns,
        ...(shownColumns !== null ? { shown_columns: shownColumns } : {}),
        ...(shownFilters !== null ? { shown_filters: shownFilters } : {}),
        ...(detailAttrs !== null ? { detail_attrs: detailAttrs } : {}),
        ...(detailSections !== null ? { detail_sections: detailSections } : {}),
      };
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
