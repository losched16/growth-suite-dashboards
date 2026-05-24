// Per-school embed tokens for iframe embeds inside GHL Dashboard widgets
// (or anywhere else). The token is a deterministic HMAC of the locationId
// keyed by EMBED_TOKEN_SECRET — no DB row needed, stable forever, but
// rotatable globally by changing the secret.
//
// Threat model:
//   - Token is shared per school, not per user. Anyone who can read the
//     iframe URL can view that school's dashboards.
//   - This is the SAME threat model as the bespoke wooster-family-hub +
//     desert-garden-admin pattern (a single ?token=XXX shared secret per
//     deployment). For internal staff dashboards embedded in GHL, this is
//     intentional and appropriate.
//   - To rotate: change EMBED_TOKEN_SECRET (invalidates ALL school
//     embed URLs at once) OR add a per-school salt column later.

import crypto from 'node:crypto';

function embedSecret(): Buffer {
  const raw = process.env.EMBED_TOKEN_SECRET;
  if (!raw) throw new Error('EMBED_TOKEN_SECRET env var is required');
  return Buffer.from(raw, 'base64');
}

// Deterministic per-school token. Same locationId always yields the same
// token (until the secret rotates). base64url so it's URL-safe.
export function deriveEmbedToken(locationId: string): string {
  return crypto
    .createHmac('sha256', embedSecret())
    .update(locationId)
    .digest('base64url');
}

export function checkEmbedToken(locationId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  let expected: string;
  try {
    expected = deriveEmbedToken(locationId);
  } catch {
    return false;
  }
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
