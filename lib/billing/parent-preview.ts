// Builds a signed, short-lived "see what this parent sees" link to the
// parent portal. The portal verifies the HMAC (keyed by the shared
// ENCRYPTION_KEY) at /api/preview-parent and logs the admin in as that
// parent. Server-only (uses the secret) — call it in a server component
// / fetcher and pass the URL down.

import crypto from 'node:crypto';

const PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';
const TTL_SECONDS = 24 * 60 * 60; // links rendered each page load; 24h is plenty

export function parentPreviewUrl(parentId: string): string | null {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || !parentId) return null;
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`${parentId}.${exp}`).digest('hex');
  return `${PORTAL_BASE}/api/preview-parent?p=${parentId}&exp=${exp}&sig=${sig}`;
}
