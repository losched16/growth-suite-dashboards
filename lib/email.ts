// Outbound email via Resend, with per-school sender overrides.
//
// Mirrors lib/email.ts in the parent portal. Per-school overrides
// (email_from_address, email_from_name, email_reply_to_address) live
// in school_branding. Fall back to env vars (RESEND_FROM_ADDRESS,
// RESEND_REPLY_TO) when not configured.

import { Resend } from 'resend';
import { query } from '@/lib/db';
import { sendEmailViaGhl } from '@/lib/email-ghl';

let _resend: Resend | undefined;

// Which provider should a school's transactional email use? Reads
// school_branding.email_provider (migration 059). Defaults to 'resend'
// for any school without a row or column value — preserves historical
// behavior for every tenant that hasn't opted into GHL email.
async function emailProviderFor(schoolId: string | null): Promise<'resend' | 'ghl'> {
  if (!schoolId) return 'resend';
  try {
    const { rows } = await query<{ email_provider: string | null }>(
      `SELECT email_provider FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    return rows[0]?.email_provider === 'ghl' ? 'ghl' : 'resend';
  } catch {
    return 'resend';
  }
}

// Returns null when RESEND_API_KEY isn't set — callers should log+skip
// rather than crash. This lets the demo run without Resend configured.
function client(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

interface SchoolSender {
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
}

async function resolveSender(schoolId: string | null): Promise<SchoolSender> {
  const envFrom = process.env.RESEND_FROM_ADDRESS ?? 'Growth Suite <family@mygrowthsuite.com>';
  const envReply = process.env.RESEND_REPLY_TO ?? null;
  if (!schoolId) return { fromAddress: envFrom, fromName: null, replyTo: envReply };
  try {
    const { rows } = await query<{
      email_from_address: string | null;
      email_from_name: string | null;
      email_reply_to_address: string | null;
    }>(
      `SELECT email_from_address, email_from_name, email_reply_to_address
         FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const r = rows[0];
    if (!r) return { fromAddress: envFrom, fromName: null, replyTo: envReply };
    return {
      fromAddress: r.email_from_address || envFrom,
      fromName: r.email_from_name,
      replyTo: r.email_reply_to_address || envReply,
    };
  } catch {
    return { fromAddress: envFrom, fromName: null, replyTo: envReply };
  }
}

function formatFrom(sender: SchoolSender): string {
  if (sender.fromAddress.includes('<')) return sender.fromAddress;
  if (sender.fromName) return `"${sender.fromName.replace(/"/g, "'")}" <${sender.fromAddress}>`;
  return sender.fromAddress;
}

export async function sendBrandedEmail(opts: {
  to: string | string[];
  schoolId: string | null;
  subject: string;
  html: string;
  text: string;
  replyToOverride?: string | null;
}): Promise<void> {
  // GHL-first when the school opted in. On ANY failure (no PIT, no
  // matching contact, API error) fall through to Resend so email never
  // silently stops.
  if (opts.schoolId && (await emailProviderFor(opts.schoolId)) === 'ghl') {
    const r = await sendEmailViaGhl({
      to: opts.to, schoolId: opts.schoolId,
      subject: opts.subject, html: opts.html, text: opts.text,
    });
    if (r.ok) return;
    console.warn('[email/branded] GHL send failed, falling back to Resend:', r.reason, '(to:', opts.to, ')');
  }

  const c = client();
  if (!c) {
    console.warn('[email/branded] RESEND_API_KEY not set — skipping send to', opts.to, '(subject:', opts.subject, ')');
    return;
  }
  const sender = await resolveSender(opts.schoolId);
  await c.emails.send({
    from: formatFrom(sender),
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyToOverride ?? sender.replyTo ?? undefined,
  });
}
