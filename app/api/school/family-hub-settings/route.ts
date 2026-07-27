// POST /api/school/family-hub-settings
//
// Saves the school's self-serve column / detail picks onto the
// family_hub_table widget config in school_dashboards.layout.
// Body: { school_id, extra_columns: string[], detail_attrs: string[],
//         column_order?: string[] }
//
// attr_keys are validated against the school's filter catalog so junk
// keys can't land in the config. Auth posture matches the other
// embedded /school config endpoints (light — the GHL iframe's cookie
// state is unreliable; the school_id scoping + catalog validation is
// the real guard). Ported from /api/school/roster-settings.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { AVAILABLE_COLUMNS } from '@/lib/widgets/components/FamilyHubTable/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  school_id?: string;
  // Catalog attr_keys shown as added table columns.
  extra_columns?: unknown;
  // Catalog attr_keys shown as extra rows in the family accordion.
  detail_attrs?: unknown;
  // Saved column display order (built-in + added keys interleaved).
  column_order?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body?.school_id) return NextResponse.json({ error: 'school_id required' }, { status: 400 });
  const schoolId = body.school_id;

  const wanted = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String).filter((s) => s.length > 0 && s.length < 200).slice(0, 100) : [];
  const reqColumns = wanted(body.extra_columns);
  const reqDetailAttrs = wanted(body.detail_attrs);

  // Validate against the catalog — only real attributes are saved.
  const { rows: cat } = await query<{ attr_key: string }>(
    `SELECT attr_key FROM school_filter_catalog WHERE school_id = $1`,
    [schoolId],
  );
  const valid = new Set(cat.map((c) => c.attr_key));
  const extraColumns = reqColumns.filter((k) => valid.has(k));
  const detailAttrs = reqDetailAttrs.filter((k) => valid.has(k));

  // Column order: any built-in family-hub column key OR a valid catalog
  // attr key. Empty array allowed (falls back to natural order).
  const validCols = new Set(AVAILABLE_COLUMNS.map((c) => c.key as string));
  const columnOrder = Array.isArray(body.column_order)
    ? body.column_order.map(String).filter((k) => validCols.has(k) || valid.has(k)).slice(0, 100)
    : null;

  // Load + update the family-hub widget config in place.
  const { rows } = await query<{ layout: Array<{ widget_id: string; config: Record<string, unknown> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'family-hub'`,
    [schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no_family_hub_dashboard', detail: 'This school has no family-hub dashboard provisioned.' }, { status: 404 });
  }
  const layout = rows[0].layout;
  let touched = false;
  for (const w of layout) {
    if (w.widget_id === 'family_hub_table') {
      w.config = {
        ...w.config,
        extra_columns: extraColumns,
        detail_attrs: detailAttrs,
        ...(columnOrder !== null ? { column_order: columnOrder } : {}),
      };
      touched = true;
    }
  }
  if (!touched) {
    return NextResponse.json({ error: 'no_family_hub_widget', detail: 'family_hub_table widget not found on the family-hub dashboard.' }, { status: 404 });
  }

  await query(
    `UPDATE school_dashboards SET layout = $2::jsonb, updated_at = now()
      WHERE school_id = $1 AND dashboard_slug = 'family-hub'`,
    [schoolId, JSON.stringify(layout)],
  );

  return NextResponse.json({
    ok: true,
    extra_columns: extraColumns,
    detail_attrs: detailAttrs,
    dropped: [...reqColumns, ...reqDetailAttrs].filter((k) => !valid.has(k)),
  });
}
