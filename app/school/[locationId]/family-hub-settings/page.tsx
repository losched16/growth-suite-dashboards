// /school/[locationId]/family-hub-settings — self-serve column/detail
// builder for the Family Hub. Lists every attribute discovered in the
// school's GHL account (tags, contact custom fields, opportunity
// stages/statuses/pipelines) and lets the school check which become
// added COLUMNS and/or extra DETAIL rows on the family accordion. Saves
// to the family_hub_table widget config in school_dashboards.layout.
//
// GHL stays the source of truth: the catalog refreshes from GHL on the
// 6-hour attribute sync, so new tags/fields appear here automatically.
// Ported from /school/[locationId]/roster-settings.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, SlidersHorizontal } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FamilyHubSettingsClient } from './FamilyHubSettingsClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;

export interface CatalogAttr {
  attr_key: string;
  attr_type: string;
  label: string;
  data_type: string | null;
  value_count: number;
  sample_values: string[];
}

export default async function FamilyHubSettingsPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: catalog } = await query<CatalogAttr & { sample_values: unknown }>(
    `SELECT attr_key, attr_type, label, data_type, value_count, sample_values
       FROM school_filter_catalog WHERE school_id = $1
      ORDER BY CASE attr_type WHEN 'tag' THEN 0 WHEN 'opportunity_stage' THEN 1
               WHEN 'opportunity_status' THEN 2 WHEN 'pipeline' THEN 3
               WHEN 'facts' THEN 4 ELSE 5 END,
               value_count DESC, label`,
    [school.id],
  );
  const attrs: CatalogAttr[] = catalog.map((c) => ({
    ...c,
    sample_values: Array.isArray(c.sample_values) ? (c.sample_values as unknown[]).map(String) : [],
  }));

  // Current selections from the family-hub widget config.
  const { rows: dashRows } = await query<{ layout: Array<{ widget_id: string; config: Record<string, unknown> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'family-hub'`,
    [school.id],
  );
  const widget = dashRows[0]?.layout?.find((w) => w.widget_id === 'family_hub_table');
  const currentColumns = Array.isArray(widget?.config?.extra_columns) ? (widget?.config?.extra_columns as string[]) : [];
  const currentDetailAttrs = Array.isArray(widget?.config?.detail_attrs) ? (widget?.config?.detail_attrs as string[]) : [];
  // Built-in columns on this hub (fixed here — used only to seed the
  // column-order list so added columns can be arranged relative to them).
  const currentShownColumns = Array.isArray(widget?.config?.shown_columns) ? (widget?.config?.shown_columns as string[]) : [];
  const currentColumnOrder = Array.isArray(widget?.config?.column_order) ? (widget?.config?.column_order as string[]) : [];

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-4xl space-y-4">
        <Link href={`/school/${locationId}/family-hub`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Family Hub
        </Link>

        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-emerald-700" />
          <h1 className="text-2xl font-semibold text-slate-900">Customize Family Hub columns &amp; detail</h1>
        </div>
        <p className="text-sm text-slate-600 max-w-2xl">
          Pick anything from your Growth Suite account — tags, contact fields, opportunity stages — to
          add as a <strong>column</strong> on the family table or as an extra <strong>detail</strong> row
          inside the expanded family report. New tags and fields you create in Growth Suite show up here
          automatically after the next sync (every 6 hours).
        </p>

        {attrs.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            No attributes synced yet for this school. The attribute sync runs every 6 hours —
            or ask your Growth Suite operator to run it now.
          </div>
        ) : (
          <FamilyHubSettingsClient
            locationId={locationId}
            schoolId={school.id}
            attrs={attrs}
            initialColumns={currentColumns}
            initialDetailAttrs={currentDetailAttrs}
            initialShownColumns={currentShownColumns}
            initialColumnOrder={currentColumnOrder}
          />
        )}
      </div>
    </main>
  );
}
