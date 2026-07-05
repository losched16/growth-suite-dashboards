// Form-handler for parent-portal menu visibility. The school picks which
// portal nav items are ON; we store the OFF ones in
// school_branding.portal_hidden_nav (text[]). The parent portal reads that
// column to filter its nav — source of truth is the DB, not code.
//
// Submit shape: a "visible" checkbox per nav item (value = href) plus a
// hidden "all_nav" input listing every href. hidden = all_nav − checked.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  try {
    const form = await request.formData();
    const all = String(form.get('all_nav') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const visible = new Set(
      form.getAll('visible').map((v) => String(v).trim()).filter(Boolean),
    );
    const hidden = all.filter((href) => !visible.has(href));

    // Upsert so a school with no branding row yet still saves.
    await query(
      `INSERT INTO school_branding (school_id, portal_hidden_nav)
       VALUES ($1, $2)
       ON CONFLICT (school_id) DO UPDATE SET portal_hidden_nav = EXCLUDED.portal_hidden_nav`,
      [schoolId, hidden],
    );

    const n = all.length - hidden.length;
    return back(request, schoolId, { msg: `Portal menus saved — ${n} on, ${hidden.length} off.` });
  } catch (err) {
    return back(request, schoolId, {
      err: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  url.hash = 'portal-menus';
  return NextResponse.redirect(url, 303);
}
