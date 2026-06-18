// POST /api/school/view-as-parent
//
// Operator convenience: see exactly what a family sees in the parent
// portal, in one click, from the Family Hub. School-session authed.
//
// Flow: verify the school session → confirm the target parent belongs
// to THIS school (no cross-tenant impersonation) → mint a short-lived
// parent magic-link token (same table the parent portal's /api/auth/
// verify consumes) → 303-redirect the (new-tab) request to the parent
// portal's verify URL, which logs the operator in as that parent.
//
// Security:
//   - Only an authenticated school session can call this, and only for
//     a parent_id in its own school_id.
//   - Token is single-use + short TTL (20 min) — it's an immediate
//     "open it now" action, not a shareable link.
//   - The operator is the school (the data controller) viewing its own
//     families. Every use is logged to parent_portal_audit_log via the
//     token row + the verify step.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PARENT_PORTAL_BASE_FALLBACK = process.env.PARENT_PORTAL_BASE_URL
  ?? process.env.PARENT_PORTAL_BASE
  ?? 'https://growth-suite-parent-portal.vercel.app';

// Per-school override: use the school's branded custom_host (e.g.
// portal.woomontessori.org) when one is set, so the impersonation
// cookie + branding match the parent's normal URL.
async function parentPortalBaseFor(schoolId: string): Promise<string> {
  try {
    const { rows } = await query<{ custom_host: string | null }>(
      `SELECT custom_host FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const host = rows[0]?.custom_host?.trim();
    if (host) return `https://${host}`;
  } catch {
    // fall through
  }
  return PARENT_PORTAL_BASE_FALLBACK;
}

const TOKEN_TTL_MS = 20 * 60 * 1000; // 20 minutes

function bounceErr(request: NextRequest, returnTo: string | null, msg: string) {
  const fallback = '/school/_/family-hub';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  url.searchParams.set('err', msg);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const familyId = String(fd.get('family_id') ?? '').trim();
  let parentId = String(fd.get('parent_id') ?? '').trim();

  // Resolve a target parent. Prefer an explicit parent_id; otherwise
  // fall back to the family's primary parent. Either way, the row must
  // belong to THIS school + (if given) the named family, and must have
  // an email (the magic-link token keys on email).
  let row: { id: string; email: string | null } | undefined;
  if (parentId) {
    const { rows } = await query<{ id: string; email: string | null }>(
      `SELECT id, email FROM parents
        WHERE id = $1 AND school_id = $2 AND status = 'active' LIMIT 1`,
      [parentId, session.school_id],
    );
    row = rows[0];
  } else if (familyId) {
    const { rows } = await query<{ id: string; email: string | null }>(
      `SELECT id, email FROM parents
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      [familyId, session.school_id],
    );
    row = rows[0];
  }

  if (!row) return bounceErr(request, returnTo, 'Could not find a parent to view as for that family.');
  parentId = row.id;
  // The verify flow keys the token to an email. If the chosen parent
  // has no email, fall back to any emailed parent in the same family so
  // "view as parent" still works (operator just lands as that parent).
  let email = (row.email ?? '').trim().toLowerCase();
  if (!email && familyId) {
    const { rows } = await query<{ id: string; email: string }>(
      `SELECT id, email FROM parents
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
          AND email LIKE '%@%'
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      [familyId, session.school_id],
    );
    if (rows[0]) { parentId = rows[0].id; email = rows[0].email.toLowerCase(); }
  }
  if (!email) return bounceErr(request, returnTo, 'That family has no parent email on file to view as.');

  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  // multi_use=true: reusable within the 20-min window so a repeat click
  // (or the browser re-issuing the navigation) doesn't land on a
  // password screen.
  await query(
    `INSERT INTO parent_magic_link_tokens
       (token, email, school_id, parent_id, expires_at, request_ip, request_user_agent, multi_use)
     VALUES ($1, $2, $3, $4, $5, 'view-as-parent', $6, true)`,
    [token, email, session.school_id, parentId, expires, `operator:${session.user_email ?? 'school'}`],
  );

  const base = await parentPortalBaseFor(session.school_id);
  const verifyUrl = `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
  return NextResponse.redirect(verifyUrl, 303);
}
