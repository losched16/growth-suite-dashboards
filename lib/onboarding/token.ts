// Pre-tenant onboarding access token. A school onboards BEFORE it's a full
// tenant, so it can't use the school-session cookie. Instead we email a signed
// link (`/onboarding/<token>`) that grants access to exactly one onboarding
// record. HMAC-signed + expiring; same shape as the other signed-link tokens
// in this codebase (view-as-parent, embed).
//
// This is a bearer link (whoever holds it can act on that onboarding, incl.
// uploading roster files with PII) — so keep the TTL bounded and re-issue
// rather than making it permanent. Default 30 days to cover a typical
// onboarding window; re-mint from the ops board to extend.

import crypto from 'node:crypto';

function secret(): Buffer {
  const raw = process.env.ONBOARDING_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!raw) throw new Error('ONBOARDING_TOKEN_SECRET (or SESSION_SECRET) env var is required');
  return Buffer.from(raw);
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function mintOnboardingToken(onboardingId: string, ttlDays = 30): string {
  const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const payload = `${onboardingId}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

// Returns the onboardingId if the token is valid + unexpired, else null.
export function verifyOnboardingToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(payload);
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [onboardingId, expStr] = payload.split('.');
  const exp = Number(expStr);
  if (!onboardingId || !Number.isFinite(exp) || Date.now() > exp) return null;
  return onboardingId;
}
