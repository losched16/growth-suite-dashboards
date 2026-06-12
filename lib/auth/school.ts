// School-admin auth. Two paths in:
//
//   1. PRODUCTION: GHL signs a JWT with the GHL_LOGIN_SECRET (a shared
//      secret you configure in GHL's Custom Menu Link). Our exchange
//      endpoint verifies that JWT, mints our own session JWT signed with
//      SCHOOL_SESSION_SECRET, and sets it as an HttpOnly SameSite=None
//      cookie so it survives iframe context.
//
//   2. DEV-ONLY BYPASS (clearly temporary, gated): if NODE_ENV !==
//      'production' AND DEV_AUTH_BYPASS === 'true', a `?dev_token=<token>`
//      query param matching INTERNAL_API_TOKEN can stand in for a GHL JWT.
//      Used while building/iterating widgets without a real GHL menu link.
//      Every use is console.warn'd AND logged to widget_fetch_log so we
//      can audit. The double gate (NODE_ENV + opt-in env var) means the
//      bypass cannot accidentally fire in production.

import { SignJWT, jwtVerify } from 'jose';
import crypto from 'node:crypto';
import { query } from '@/lib/db';

export const SCHOOL_SESSION_COOKIE = 'gsd_school_session';
export const SCHOOL_SESSION_TTL_S = 8 * 60 * 60; // 8 hours per brief §10.2

interface SchoolSessionClaims {
  school_id: string;
  ghl_location_id: string;
  user_email: string;
  user_name: string;
  via?: 'ghl' | 'dev' | 'staff';   // audit trail — 'staff' = magic-link login (standalone schools)
}

interface GhlMenuLinkClaims {
  locationId: string;
  userId?: string;
  email?: string;
  name?: string;
  exp?: number;
}

function schoolSessionSecret(): Uint8Array {
  const raw = process.env.SCHOOL_SESSION_SECRET;
  if (!raw) throw new Error('SCHOOL_SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

function ghlLoginSecret(): Uint8Array {
  const raw = process.env.GHL_LOGIN_SECRET;
  if (!raw) throw new Error('GHL_LOGIN_SECRET env var is required');
  // GHL signs with the secret as a string; jose accepts Uint8Array. Try
  // raw bytes first (base64-decoded), fall back to UTF-8 if needed at
  // verify time. v1 assumes the secret is configured as base64 random.
  return new TextEncoder().encode(raw);
}

export async function verifyGhlMenuLinkJwt(token: string): Promise<GhlMenuLinkClaims> {
  const { payload } = await jwtVerify(token, ghlLoginSecret(), { algorithms: ['HS256'] });
  return payload as unknown as GhlMenuLinkClaims;
}

export async function mintSchoolSession(claims: SchoolSessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SCHOOL_SESSION_TTL_S}s`)
    .sign(schoolSessionSecret());
}

export async function verifySchoolSession(token: string | undefined | null): Promise<SchoolSessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, schoolSessionSecret(), { algorithms: ['HS256'] });
    return payload as unknown as SchoolSessionClaims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dev-token bypass
// ---------------------------------------------------------------------------

export function devBypassEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true';
}

// Returns true if the supplied dev token is acceptable (matches
// INTERNAL_API_TOKEN, constant-time compared) AND the bypass is enabled.
// Always returns false in production regardless of token value.
export function checkDevBypass(token: string | null | undefined): boolean {
  if (!devBypassEnabled()) return false;
  if (!token) return false;
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Audit: log + console.warn every dev bypass use. Best-effort; we don't
// want to fail auth because the audit table errored.
export async function auditDevBypass(opts: {
  schoolId: string;
  path: string;
}): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn(
    '[DEV_AUTH_BYPASS] used at',
    opts.path,
    'for school',
    opts.schoolId,
    '— this should NEVER appear in production logs',
  );
  try {
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, error)
       VALUES ($1, $2, $3, $4)`,
      [opts.schoolId, '_auth', '_dev_bypass', `bypass used for ${opts.path}`]
    );
  } catch {
    // swallow; audit failure must not block auth in dev
  }
}
