// POST delete-dashboard: hard-removes a dashboard row. Requires
// `confirm=DELETE` to avoid fat-finger removal.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId } = await params;
  try {
    const form = await request.formData();
    const confirm = String(form.get('confirm') ?? '').trim();
    if (confirm !== 'DELETE') {
      return backToSchool(request, schoolId, {
        err: 'Type DELETE in the confirmation box to remove the dashboard.',
      });
    }

    const { rowCount } = await query(
      `DELETE FROM school_dashboards WHERE id = $1 AND school_id = $2`,
      [dashboardId, schoolId],
    );
    if (!rowCount) return backToSchool(request, schoolId, { err: 'Dashboard not found.' });

    return backToSchool(request, schoolId, { msg: 'Dashboard removed.' });
  } catch (err) {
    return backToSchool(request, schoolId, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function backToSchool(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
