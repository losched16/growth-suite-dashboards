// POST /api/admin/onboarding/[id]/review-doc — operator accepts/rejects a
// submitted intake document. Operator-only. Accepting a doc flips its task's
// state to done (via the status engine's 'accepted' → done rule).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const fd = await request.formData();
  const docId = String(fd.get('doc_id') ?? '').trim();
  const action = String(fd.get('action') ?? '').trim();

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/onboarding/${id}`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  if (action !== 'accept' && action !== 'reject') return back({ err: 'Bad action.' });
  const newStatus = action === 'accept' ? 'accepted' : 'rejected';

  // Scope the update to this onboarding so an operator can't touch another
  // record's doc by id.
  const { rows } = await query<{ task_key: string }>(
    `UPDATE onboarding_documents
        SET status = $3, reviewed_by_email = 'operator'
      WHERE id = $1 AND onboarding_id = $2
      RETURNING task_key`,
    [docId, id, newStatus],
  );
  if (!rows[0]) return back({ err: 'Document not found.' });

  return back({ msg: `Document ${newStatus}.` });
}
