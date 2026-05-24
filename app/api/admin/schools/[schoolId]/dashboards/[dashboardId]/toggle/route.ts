import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId } = await params;
  await query(
    `UPDATE school_dashboards
       SET is_enabled = NOT is_enabled, updated_at = now()
       WHERE id = $1 AND school_id = $2`,
    [dashboardId, schoolId]
  );
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  return NextResponse.redirect(url, 303);
}
