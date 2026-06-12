// Staff magic-link auth — the non-GHL sign-in path for standalone
// schools. Mirrors the parent portal's parent_magic_link_tokens
// pattern: single-use random token, short TTL, email delivery via
// Resend's REST API (no SDK dependency in this repo). When
// RESEND_API_KEY isn't configured the link is logged to the server
// console instead, so dev/preview environments still work.

import crypto from 'node:crypto';
import { query } from '@/lib/db';

const TOKEN_TTL_MIN = 15;
const MAX_REQUESTS_PER_10MIN = 5;

export interface StaffMatch {
  staff_id: string;
  school_id: string;
  school_name: string;
  ghl_location_id: string;
  email: string;
  name: string | null;
}

export async function lookupStaffByEmail(rawEmail: string): Promise<StaffMatch[]> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes('@')) return [];
  const { rows } = await query<StaffMatch>(
    `SELECT st.id AS staff_id, st.school_id, s.name AS school_name,
            s.ghl_location_id, lower(st.email) AS email, st.name
       FROM school_staff st
       JOIN schools s ON s.id = st.school_id
      WHERE lower(st.email) = $1 AND st.status = 'active'`,
    [email],
  );
  return rows;
}

// Issue one token per (staff, school) match. Rate-limited per email so
// the endpoint can't be used to spam someone's inbox.
export async function issueStaffTokens(matches: StaffMatch[], requestIp: string | null): Promise<Array<{ match: StaffMatch; token: string }>> {
  if (matches.length === 0) return [];
  const { rows: recent } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM staff_login_tokens
      WHERE lower(email) = $1 AND created_at > now() - interval '10 minutes'`,
    [matches[0].email],
  );
  if (Number(recent[0]?.n ?? 0) >= MAX_REQUESTS_PER_10MIN) return [];

  const out: Array<{ match: StaffMatch; token: string }> = [];
  const expires = new Date(Date.now() + TOKEN_TTL_MIN * 60_000).toISOString();
  for (const m of matches) {
    const token = crypto.randomBytes(24).toString('base64url');
    await query(
      `INSERT INTO staff_login_tokens (token, staff_id, school_id, email, expires_at, request_ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [token, m.staff_id, m.school_id, m.email, expires, requestIp],
    );
    out.push({ match: m, token });
  }
  return out;
}

export interface ConsumedStaffToken {
  staff_id: string;
  school_id: string;
  email: string;
  staff_name: string | null;
  ghl_location_id: string;
}

// Single-use consume: marks used_at atomically so a replayed link fails.
export async function consumeStaffToken(token: string): Promise<ConsumedStaffToken | null> {
  if (!token || token.length < 16) return null;
  const { rows } = await query<ConsumedStaffToken>(
    `UPDATE staff_login_tokens t
        SET used_at = now()
       FROM school_staff st, schools s
      WHERE t.token = $1 AND t.used_at IS NULL AND t.expires_at > now()
        AND st.id = t.staff_id AND st.status = 'active'
        AND s.id = t.school_id
      RETURNING t.staff_id, t.school_id, t.email, st.name AS staff_name, s.ghl_location_id`,
    [token],
  );
  return rows[0] ?? null;
}

// Send the sign-in email via Resend's REST API. Falls back to a console
// log when RESEND_API_KEY is missing so the flow is testable without
// email infra.
export async function sendStaffLoginEmail(opts: {
  to: string;
  schoolName: string;
  loginUrl: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[staff-login] RESEND_API_KEY not set — magic link for ${opts.to} (${opts.schoolName}): ${opts.loginUrl}`);
    return;
  }
  const from = process.env.RESEND_FROM_ADDRESS || 'Growth Suite <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: `Your sign-in link — ${opts.schoolName}`,
      html: `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827;">
  <h2 style="margin:0 0 12px;font-size:18px;">Sign in to ${opts.schoolName}</h2>
  <p style="margin:0 0 16px;font-size:14px;line-height:1.5;">Click below to open your school dashboard. The link expires in 15 minutes and works once.</p>
  <p style="margin:24px 0;"><a href="${opts.loginUrl}" style="display:inline-block;background:#047857;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600;">Sign in</a></p>
  <p style="margin:16px 0 0;font-size:11px;color:#6b7280;word-break:break-all;">Or paste this link into your browser: ${opts.loginUrl}</p>
</div>`.trim(),
      text: `Sign in to ${opts.schoolName}\n\nOpen this link (expires in 15 minutes, works once):\n${opts.loginUrl}`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[staff-login] Resend send failed ${res.status}: ${detail.slice(0, 300)}`);
  }
}
