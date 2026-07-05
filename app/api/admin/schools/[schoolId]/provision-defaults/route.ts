import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { provisionDefaults } from '@/lib/dashboards/provision';

// Form-handler counterpart to /api/v1/schools/{id}/provision-defaults.
// Cookie-auth (operator session) via proxy.ts — no bearer required.
type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const ok = (msg: string) => redirectBack(request, schoolId, { msg });
  const fail = (err: string) => redirectBack(request, schoolId, { err });

  try {
    const result = await provisionDefaults(schoolId);
    if (result.created.length === 0) {
      return ok(`All ${result.skipped.length} dashboards already provisioned.`);
    }
    return ok(`Created ${result.created.length} dashboard${result.created.length === 1 ? '' : 's'}: ${result.created.join(', ')}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function redirectBack(
  request: NextRequest,
  schoolId: string,
  query: { msg?: string; err?: string }
) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (query.msg) url.searchParams.set('msg', query.msg);
  if (query.err) url.searchParams.set('err', query.err);
  return NextResponse.redirect(url, 303);
}
