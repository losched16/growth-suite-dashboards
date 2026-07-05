// POST /api/admin/onboarding/guides/save — operator sets the help content
// (Freshdesk article URL + optional label + video) for each onboarding task.
// Operator-only. One form, all tasks; upserts onboarding_guides, deletes rows
// left fully blank. Content itself stays in Freshdesk — this only stores links.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { ONBOARDING_CHECKLIST } from '@/lib/onboarding/checklist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clean(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 1000) : null;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const fd = await request.formData();

  let saved = 0;
  for (const task of ONBOARDING_CHECKLIST) {
    const url = clean(fd.get(`guide_url__${task.key}`));
    const label = clean(fd.get(`guide_label__${task.key}`));
    const video = clean(fd.get(`video_url__${task.key}`));

    if (!url && !label && !video) {
      await query(`DELETE FROM onboarding_guides WHERE task_key = $1`, [task.key]);
      continue;
    }
    await query(
      `INSERT INTO onboarding_guides (task_key, guide_url, guide_label, video_url, updated_by_email, updated_at)
       VALUES ($1, $2, $3, $4, 'operator', now())
       ON CONFLICT (task_key) DO UPDATE SET
         guide_url = EXCLUDED.guide_url,
         guide_label = EXCLUDED.guide_label,
         video_url = EXCLUDED.video_url,
         updated_by_email = EXCLUDED.updated_by_email,
         updated_at = now()`,
      [task.key, url, label, video],
    );
    saved++;
  }

  const url = request.nextUrl.clone();
  url.pathname = '/admin/onboarding/guides';
  url.search = '';
  url.searchParams.set('msg', `Saved help links for ${saved} task${saved === 1 ? '' : 's'}.`);
  return NextResponse.redirect(url, 303);
}
