// Form-handler that updates a single widget instance's config inside
// school_dashboards.layout (a JSONB array). v1: knows about the
// EnrollmentHubTable form fields specifically; for any other widget, accepts
// a config_json textarea.

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { editorRedirect } from '@/lib/dashboards/editor-redirect';
import type { WidgetInstance } from '@/lib/widgets/types';
import {
  AVAILABLE_FILTERS,
  AVAILABLE_COLUMNS,
  type FilterKey,
  type ColumnKey,
} from '@/lib/widgets/components/EnrollmentHubTable/config';
import {
  AVAILABLE_TABS as RH_TABS,
  type TabKey as RHTabKey,
} from '@/lib/widgets/components/RostersHub/config';

type Params = Promise<{ schoolId: string; dashboardId: string; instanceId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId, instanceId } = await params;
  const form = await request.formData();

  const { rows } = await query<{ layout: WidgetInstance[] }>(
    `SELECT layout FROM school_dashboards WHERE id = $1 AND school_id = $2`,
    [dashboardId, schoolId],
  );
  if (rows.length === 0) return back(request, schoolId, dashboardId, { err: 'Dashboard not found' });
  const layout = rows[0].layout;

  const idx = layout.findIndex((w) => w.instance_id === instanceId);
  if (idx === -1) return back(request, schoolId, dashboardId, { err: 'Widget not found in layout' });
  const widget = layout[idx];

  let newConfig: unknown;
  try {
    newConfig = parseConfigFromForm(widget.widget_id, form);
  } catch (err) {
    return back(request, schoolId, dashboardId, {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  layout[idx] = { ...widget, config: newConfig };
  await query(
    `UPDATE school_dashboards SET layout = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(layout), dashboardId],
  );

  return back(request, schoolId, dashboardId, { msg: `Updated ${widget.widget_id} config.` });
}

function parseConfigFromForm(widgetId: string, form: FormData): unknown {
  if (widgetId === 'enrollment_hub_table') {
    const validFilterKeys = new Set<FilterKey>(AVAILABLE_FILTERS.map((f) => f.key));
    const validColumnKeys = new Set<ColumnKey>(AVAILABLE_COLUMNS.map((c) => c.key));
    const shown_filters = form.getAll('shown_filters')
      .map(String)
      .filter((v): v is FilterKey => validFilterKeys.has(v as FilterKey));
    const shown_columns = form.getAll('shown_columns')
      .map(String)
      .filter((v): v is ColumnKey => validColumnKeys.has(v as ColumnKey));
    const academic_year = String(form.get('academic_year') ?? '').trim();
    const drilldown = String(form.get('drilldown_dashboard_slug') ?? '').trim() || 'family-hub';
    return {
      academic_year: academic_year || undefined,
      shown_filters,
      shown_columns,
      show_stat_cards: form.get('show_stat_cards') !== null,
      show_breakdowns: form.get('show_breakdowns') !== null,
      drilldown_dashboard_slug: drilldown,
    };
  }

  if (widgetId === 'rosters_hub') {
    const validTabs = new Set<RHTabKey>(RH_TABS.map((t) => t.key));
    const shown_tabs = form.getAll('shown_tabs')
      .map(String)
      .filter((v): v is RHTabKey => validTabs.has(v as RHTabKey));
    const default_tab = String(form.get('default_tab') ?? 'school_year') as RHTabKey;
    return {
      shown_tabs,
      default_tab: validTabs.has(default_tab) ? default_tab : 'school_year',
      drilldown_dashboard_slug: String(form.get('drilldown_dashboard_slug') ?? 'family-hub').trim() || 'family-hub',
    };
  }

  if (widgetId === 'document_tracker') {
    const auto = Number(form.get('auto_refresh_ms') ?? 60000);
    return {
      auto_refresh_ms: Number.isFinite(auto) && auto >= 0 ? auto : 60_000,
      drilldown_dashboard_slug: String(form.get('drilldown_dashboard_slug') ?? 'family-hub').trim() || 'family-hub',
    };
  }

  if (widgetId === 'finance_dashboard') {
    const groupsJson = String(form.get('program_groups_json') ?? '').trim();
    let program_groups: unknown[] = [];
    if (groupsJson) {
      try {
        const parsed = JSON.parse(groupsJson);
        if (!Array.isArray(parsed)) throw new Error('program_groups_json must be an array');
        program_groups = parsed;
      } catch (e) {
        throw new Error(`program_groups_json invalid: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      program_groups,
      show_actual_payments_placeholder: form.get('show_actual_payments_placeholder') !== null,
      show_recipient_lists: form.get('show_recipient_lists') !== null,
    };
  }

  // Generic: parse JSON textarea
  const raw = String(form.get('config_json') ?? '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`config_json invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function back(
  request: NextRequest,
  schoolId: string,
  dashboardId: string,
  q: { msg?: string; err?: string },
) {
  return editorRedirect(request, schoolId, dashboardId, q);
}
