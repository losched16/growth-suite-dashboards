import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const form = await request.formData();
  const display_name = String(form.get('display_name') ?? '').trim();
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (!display_name) {
    url.searchParams.set('err', 'Display name cannot be empty.');
    return NextResponse.redirect(url, 303);
  }
  await query(
    `UPDATE school_dashboards SET display_name = $1, updated_at = now()
       WHERE id = $2 AND school_id = $3`,
    [display_name, dashboardId, schoolId]
  );
  return NextResponse.redirect(url, 303);
}
