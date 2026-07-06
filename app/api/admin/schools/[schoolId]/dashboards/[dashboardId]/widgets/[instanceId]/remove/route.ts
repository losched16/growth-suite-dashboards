// POST remove-widget: removes the matching instance from the layout.

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { editorRedirect } from '@/lib/dashboards/editor-redirect';
import type { WidgetInstance } from '@/lib/widgets/types';

type Params = Promise<{ schoolId: string; dashboardId: string; instanceId: string }>;

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId, instanceId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  try {
    const { rows } = await query<{ layout: WidgetInstance[] }>(
      `SELECT layout FROM school_dashboards WHERE id = $1 AND school_id = $2`,
      [dashboardId, schoolId],
    );
    if (rows.length === 0) return back(_request, schoolId, dashboardId, { err: 'Dashboard not found' });

    const layout = rows[0].layout;
    const before = layout.length;
    const filtered = layout.filter((w) => w.instance_id !== instanceId);
    if (filtered.length === before) return back(_request, schoolId, dashboardId, { err: 'Widget not found' });

    await query(
      `UPDATE school_dashboards SET layout = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(filtered), dashboardId],
    );
    return back(_request, schoolId, dashboardId, { msg: 'Widget removed.' });
  } catch (err) {
    return back(_request, schoolId, dashboardId, {
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
