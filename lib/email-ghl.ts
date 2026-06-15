// GHL email send path. Routes a transactional email through the
// school's GHL location via the Conversations API (type=Email) instead
// of Resend. Used by lib/email.ts when the school's email_provider is
// 'ghl'.
//
// Why GHL: every email then threads into the contact's GHL conversation
// history and uses the school's own configured sending domain. The
// caller (lib/email.ts) always wraps this in a try/catch and falls back
// to Resend on ANY failure, so this can throw freely.
//
// Resolving the recipient → contactId: GHL email sends address a
// CONTACT, not a raw address. We look up the parent by email within the
// school. A recipient with no matching parent contact (e.g. an operator
// or a brand-new lead) returns null → caller falls back to Resend.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { sendMessage } from '@/lib/ghl/conversations';

export interface GhlEmailResult {
  ok: boolean;
  reason?: string;
}

// Resolve a single recipient email to a GHL contact id within the school.
async function contactIdForEmail(schoolId: string, email: string): Promise<string | null> {
  const { rows } = await query<{ ghl_contact_id: string | null }>(
    `SELECT ghl_contact_id FROM parents
      WHERE school_id = $1 AND lower(email) = lower($2)
        AND ghl_contact_id IS NOT NULL
      ORDER BY is_primary DESC, created_at
      LIMIT 1`,
    [schoolId, email],
  );
  return rows[0]?.ghl_contact_id ?? null;
}

// Send one branded email through GHL. Returns ok:false (never throws to
// the point of crashing the request) when the recipient can't be mapped
// to a contact or the API fails — the caller falls back to Resend.
export async function sendEmailViaGhl(opts: {
  to: string | string[];
  schoolId: string;
  subject: string;
  html: string;
  text: string;
}): Promise<GhlEmailResult> {
  const recipients = Array.isArray(opts.to) ? opts.to : [opts.to];
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

  let client;
  try {
    client = await loadGhlClient(opts.schoolId);
  } catch (err) {
    return { ok: false, reason: `ghl_client: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Each recipient must resolve to a contact. If ANY can't, we report
  // not-ok so the caller sends the whole message via Resend instead —
  // simpler + avoids a partial split-delivery across two providers.
  const contactIds: string[] = [];
  for (const r of recipients) {
    const cid = await contactIdForEmail(opts.schoolId, r);
    if (!cid) return { ok: false, reason: `no_contact_for:${r}` };
    contactIds.push(cid);
  }

  try {
    for (const contactId of contactIds) {
      await sendMessage(client, {
        contactId,
        type: 'Email',
        subject: opts.subject,
        html: opts.html,
        body: opts.text,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `ghl_send: ${err instanceof Error ? err.message : String(err)}` };
  }
}
