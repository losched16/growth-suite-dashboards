// POST add-widget: appends a new widget instance to the layout.
// Body: widget_id (required) — widget gets initialized with its
// definition's default_config.

import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { editorRedirect } from '@/lib/dashboards/editor-redirect';
import { getWidget } from '@/lib/widgets/registry';
import type { WidgetInstance } from '@/lib/widgets/types';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId } = await params;
  try {
    const form = await request.formData();
    const widgetId = String(form.get('widget_id') ?? '').trim();
    if (!widgetId) return back(request, schoolId, dashboardId, { err: 'widget_id required' });

    const def = getWidget(widgetId);
    if (!def) return back(request, schoolId, dashboardId, { err: `unknown widget: ${widgetId}` });

    const { rows } = await query<{ layout: WidgetInstance[] }>(
      `SELECT layout FROM school_dashboards WHERE id = $1 AND school_id = $2`,
      [dashboardId, schoolId],
    );
    if (rows.length === 0) return back(request, schoolId, dashboardId, { err: 'Dashboard not found' });

    const layout = rows[0].layout;
    const lastY = layout.reduce((m, w) => Math.max(m, (w.position?.y ?? 0) + (w.position?.h ?? 4)), 0);
    const newInstance: WidgetInstance = {
      instance_id: randomUUID(),
      widget_id: widgetId,
      config: def.default_config,
      position: { x: 0, y: lastY, w: def.default_size.w, h: def.default_size.h },
    };
    layout.push(newInstance);

    await query(
      `UPDATE school_dashboards SET layout = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(layout), dashboardId],
    );

    return back(request, schoolId, dashboardId, { msg: `Added "${def.display_name}".` });
  } catch (err) {
    return back(request, schoolId, dashboardId, {
      err: err instanceof Error ? err.message : String(err),
    });
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
