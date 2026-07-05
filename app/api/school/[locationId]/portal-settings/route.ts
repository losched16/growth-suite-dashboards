// School-facing save for parent-portal settings: branding + which portal
// menus are on/off. School-scoped (school session OR operator), scoped to
// the locationId in the path. Upserts school_branding and redirects back to
// the school Settings page. The parent portal reads these columns directly.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';

type Params = Promise<{ locationId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  // Auth: operator OR the school's own session (scoped to this school).
  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const authorized = isOperator || (schoolSession && schoolSession.school_id === school.id);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const form = await request.formData();
    const display_name = strOrNull(form.get('display_name'));
    const logo_url = strOrNull(form.get('logo_url'));
    const primary_color = strOrNull(form.get('primary_color')) ?? '#047857';
    const primary_color_soft = strOrNull(form.get('primary_color_soft')) ?? '#ecfdf5';
    const primary_color_fg = strOrNull(form.get('primary_color_fg')) ?? '#064e3b';
    const support_email = strOrNull(form.get('support_email'));
    const support_phone = strOrNull(form.get('support_phone'));

    // Custom portal domain. Normalize to a bare lowercase hostname; the
    // parent portal matches on lower(custom_host) and a unique index keeps
    // two schools from claiming the same host (parent-portal migration 009).
    const custom_host = normalizeHost(strOrNull(form.get('custom_host')));
    if (custom_host && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(custom_host)) {
      return back(request, locationId, {
        err: `"${custom_host}" doesn't look like a valid domain. Enter just the hostname, e.g. portal.yourschool.org.`,
      });
    }

    // Portal menus: hidden = every nav href − the ones left checked ("visible").
    const all = String(form.get('all_nav') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const visible = new Set(form.getAll('visible').map((v) => String(v).trim()).filter(Boolean));
    const hidden = all.filter((href) => !visible.has(href));

    await query(
      `INSERT INTO school_branding
         (school_id, display_name, logo_url, primary_color, primary_color_soft,
          primary_color_fg, support_email, support_phone, custom_host, portal_hidden_nav)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (school_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         logo_url = EXCLUDED.logo_url,
         primary_color = EXCLUDED.primary_color,
         primary_color_soft = EXCLUDED.primary_color_soft,
         primary_color_fg = EXCLUDED.primary_color_fg,
         support_email = EXCLUDED.support_email,
         support_phone = EXCLUDED.support_phone,
         custom_host = EXCLUDED.custom_host,
         portal_hidden_nav = EXCLUDED.portal_hidden_nav`,
      [school.id, display_name, logo_url, primary_color, primary_color_soft,
       primary_color_fg, support_email, support_phone, custom_host, hidden],
    );

    return back(request, locationId, { msg: 'Portal settings saved.' });
  } catch (err) {
    // Unique-index violation on lower(custom_host): another school owns it.
    const code = (err as { code?: string })?.code;
    if (code === '23505') {
      return back(request, locationId, {
        err: 'That custom domain is already in use by another school. Pick a different hostname.',
      });
    }
    return back(request, locationId, { err: `Save failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// Reduce whatever the school typed to a bare lowercase hostname:
// strip scheme, any path, and a trailing port. "https://Portal.School.org/"
// → "portal.school.org". Returns null for empty input.
function normalizeHost(raw: string | null): string | null {
  if (!raw) return null;
  const h = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  return h || null;
}

function back(request: NextRequest, locationId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/school/${locationId}/settings`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
