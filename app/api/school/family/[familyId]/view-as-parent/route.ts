// GET /api/school/family/[familyId]/view-as-parent?next=<path>
//
// Returns a 303 redirect to the parent portal logged in as the family's
// primary parent. Used by admin "View as parent" chips on dashboards.
//
// Implementation: mints a single-use, 10-minute magic-link token in
// parent_magic_link_tokens (the same table the parent's own login
// uses) and redirects to /api/auth/verify on the parent portal. That
// flow is battle-tested: Rachel's manual login used it earlier today.
//
// Why not the dedicated HMAC token? It required a shared
// VIEW_AS_PARENT_SECRET / EMBED_TOKEN_SECRET across BOTH Vercel
// projects, which we couldn't reliably keep in sync. Magic-link only
// needs DB access, which we already have.
//
// Auth: operator session OR school session OR embed_token in URL
// (third-party iframe-safe, since cookies don't survive new-tab
// open from the embedded iframe).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = Promise<{ familyId: string }>;

interface ParentRow {
  id: string;
  school_id: string;
  email: string | null;
  first_name: string | null;
  is_primary: boolean;
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 min — operator clicks chip, click-through is immediate

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
  return process.env.PARENT_PORTAL_BASE_URL
    ?? process.env.PARENT_PORTAL_BASE
    ?? 'https://growth-suite-parent-portal.vercel.app';
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { familyId } = await params;
  const embedToken = request.nextUrl.searchParams.get('embed_token');

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);

  // Pick the family's primary active parent. Falls back to any active
  // parent if no primary is flagged. Must have an email — magic-link
  // tokens key on email.
  const { rows } = await query<ParentRow & { ghl_location_id: string | null }>(
    `SELECT p.id, p.school_id, p.email, p.first_name, p.is_primary,
            s.ghl_location_id
       FROM parents p
       JOIN schools s ON s.id = p.school_id
      WHERE p.family_id = $1 AND p.status = 'active'
        AND p.email IS NOT NULL AND p.email <> ''
      ORDER BY p.is_primary DESC, p.created_at ASC
      LIMIT 1`,
    [familyId],
  );
  const parent = rows[0];
  if (!parent) {
    return NextResponse.json({ error: 'no_active_parent_with_email' }, { status: 404 });
  }

  const embedOk = embedToken && parent.ghl_location_id
    ? checkEmbedToken(parent.ghl_location_id, embedToken)
    : false;

  if (!isOperator && !schoolSession && !embedOk) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isOperator && !embedOk && schoolSession && parent.school_id !== schoolSession.school_id) {
    return NextResponse.json({ error: 'cross_school_impersonation_blocked' }, { status: 403 });
  }

  // Mint a magic-link token directly into the parent portal's table.
  // Same shape parents use for their own login — the /api/auth/verify
  // route consumes it idempotently (consumed_at + expires_at check).
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  await query(
    `INSERT INTO parent_magic_link_tokens
       (token, email, school_id, parent_id, expires_at, request_ip, request_user_agent)
     VALUES ($1, $2, $3, $4, $5, 'view-as-parent', 'admin-impersonation')`,
    [token, parent.email!.toLowerCase(), parent.school_id, parent.id, expiresAt],
  );

  const base = await parentPortalBaseFor(parent.school_id);
  const verifyUrl = `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
  return NextResponse.redirect(verifyUrl, 303);
}
