// Form-handler for parent-portal branding (display_name, colors, support
// info). Upserts into the school_branding table that lives in the parent
// portal's migration but is shared across the same DB.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  try {
    const form = await request.formData();
    const display_name = strOrNull(form.get('display_name'));
    const logo_url = strOrNull(form.get('logo_url'));
    const primary_color = strOrNull(form.get('primary_color')) ?? '#047857';
    const primary_color_soft = strOrNull(form.get('primary_color_soft')) ?? '#ecfdf5';
    const primary_color_fg = strOrNull(form.get('primary_color_fg')) ?? '#064e3b';
    const support_email = strOrNull(form.get('support_email'));
    const support_phone = strOrNull(form.get('support_phone'));
    const footer_html = strOrNull(form.get('footer_html'));

    await query(
      `INSERT INTO school_branding
         (school_id, display_name, logo_url, primary_color, primary_color_soft,
          primary_color_fg, support_email, support_phone, footer_html)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (school_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         logo_url = EXCLUDED.logo_url,
         primary_color = EXCLUDED.primary_color,
         primary_color_soft = EXCLUDED.primary_color_soft,
         primary_color_fg = EXCLUDED.primary_color_fg,
         support_email = EXCLUDED.support_email,
         support_phone = EXCLUDED.support_phone,
         footer_html = EXCLUDED.footer_html`,
      [schoolId, display_name, logo_url, primary_color, primary_color_soft, primary_color_fg, support_email, support_phone, footer_html],
    );

    return back(request, schoolId, { msg: 'Parent portal branding saved.' });
  } catch (err) {
    return back(request, schoolId, {
      err: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  url.hash = 'parent-portal';
  return NextResponse.redirect(url, 303);
}
