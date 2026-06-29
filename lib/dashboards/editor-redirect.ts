import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Redirect a dashboard-editor form POST back to the page it was submitted
// from — /admin/[schoolId]/dashboard/[id] OR
// /school/[locationId]/dashboard/[id] — using the same-origin Referer, so the
// SAME widget endpoints serve both the operator and the school-facing editor.
// Falls back to the operator path when the Referer is missing/foreign.
export function editorRedirect(
  request: NextRequest,
  schoolId: string,
  dashboardId: string,
  q: { msg?: string; err?: string },
): NextResponse {
  let dest = `/admin/${schoolId}/dashboard/${dashboardId}`;
  const ref = request.headers.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === request.nextUrl.origin
        && /^\/(admin|school)\/[^/]+\/dashboard\/[^/?#]+/.test(u.pathname)) {
        dest = u.pathname;
      }
    } catch { /* ignore unparseable referer */ }
  }
  const url = new URL(dest, request.nextUrl.origin);
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
