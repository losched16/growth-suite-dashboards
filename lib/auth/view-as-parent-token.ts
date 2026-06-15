// "View as parent" short-lived signed token, used by admin
// impersonation links in the dashboards UI.
//
// Flow:
//   1. Admin (school-session OR operator) clicks "View as parent" on
//      a family row.
//   2. mintViewAsParentToken() returns a parent-portal URL with the
//      token in the query string.
//   3. Parent portal's /api/admin-impersonate route verifies the
//      token, looks up the parent, mints a real session JWT, sets
//      the cookie, and redirects to /home.
//
// Signed via HMAC-SHA256 with VIEW_AS_PARENT_SECRET (falls back to
// EMBED_TOKEN_SECRET so deployment doesn't need a second secret).
// Token format: base64url({parentId, exp, schoolId}) + "." + sig
// Expires in 5 minutes — short enough that a leaked URL is harmless
// but long enough that the admin can click it.

import crypto from 'node:crypto';

const TOKEN_TTL_S = 5 * 60;

function secret(): Buffer {
  const raw = process.env.VIEW_AS_PARENT_SECRET ?? process.env.EMBED_TOKEN_SECRET;
  if (!raw) throw new Error('VIEW_AS_PARENT_SECRET or EMBED_TOKEN_SECRET env var required');
  return Buffer.from(raw, 'base64');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export interface ViewAsParentPayload {
  parent_id: string;
  school_id: string;
  exp: number;   // unix seconds
}

// Mint the URL the admin should be redirected to. The parent-portal
// side validates + mints a parent session.
export function mintViewAsParentUrl(opts: {
  parentId: string;
  schoolId: string;
  parentPortalBase?: string;
  /** Page to land on after the parent session is minted. */
  next?: string;
}): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const payload: ViewAsParentPayload = {
    parent_id: opts.parentId,
    school_id: opts.schoolId,
    exp,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${encoded}.${sign(encoded)}`;

  const base = opts.parentPortalBase
    ?? process.env.PARENT_PORTAL_BASE_URL
    ?? 'https://growth-suite-parent-portal.vercel.app';
  const u = new URL(`${base}/api/admin-impersonate`);
  u.searchParams.set('token', token);
  if (opts.next) u.searchParams.set('next', opts.next);
  return u.toString();
}

// Verify a token. Used by the parent-portal side.
export function verifyViewAsParentToken(token: string | null | undefined): ViewAsParentPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const givenSig = token.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = sign(encoded);
  } catch {
    return null;
  }
  const a = Buffer.from(givenSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload: ViewAsParentPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.parent_id !== 'string' || typeof payload.school_id !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
