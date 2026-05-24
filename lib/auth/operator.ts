import crypto from 'node:crypto';

// Single-operator password gate, HMAC-signed session cookie.
// Same shape as importer/family-graph but cookie name is per-app.

export const SESSION_COOKIE = 'gsd_operator_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionSecret(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error('SESSION_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function checkPassword(submitted: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(submitted, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createSessionToken(): { value: string; expires: Date } {
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const expiry = expires.toISOString();
  return { value: `${expiry}.${sign(expiry)}`, expires };
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const expiry = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(expiry);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  const expMs = Date.parse(expiry);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  return true;
}
