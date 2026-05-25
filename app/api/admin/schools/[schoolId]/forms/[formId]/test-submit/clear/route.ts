// POST /api/admin/schools/{schoolId}/forms/{formId}/test-submit/clear
//
// Hard-deletes every test submission for a given form definition.
// Real submissions (is_test=false) are NEVER touched.
//
// Body (multipart or urlencoded form):
//   return_to — where to redirect after the delete (validated, must
//               be a /school/* or /admin/* path).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; formId: string }>;

function safeReturn(returnTo: string | null, schoolId: string, formId: string): string {
  if (returnTo && /^\/(school|admin)\//.test(returnTo) && !returnTo.includes('://')) {
    return returnTo;
  }
  return `/admin/${schoolId}/forms/${formId}/submissions`;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorizeOperatorOrSchool(schoolId);
  if (!auth.ok) return auth.response;

  const fd = await request.formData().catch(() => null);
  const returnTo = fd ? String(fd.get('return_to') ?? '') : '';

  // Belt-and-suspenders: filter on is_test=true AND form_definition_id AND
  // school_id. Even with one of these the others won't let a real row through,
  // but cheap to be paranoid.
  const result = await query<{ id: string }>(
    `DELETE FROM portal_form_submissions
       WHERE form_definition_id = $1
         AND school_id = $2
         AND is_test = true
     RETURNING id`,
    [formId, schoolId],
  );

  const target = new URL(safeReturn(returnTo || null, schoolId, formId), request.url);
  target.searchParams.set('msg', `Cleared ${result.rows.length} test submission${result.rows.length === 1 ? '' : 's'}.`);
  return NextResponse.redirect(target, 303);
}
