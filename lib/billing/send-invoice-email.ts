// Sends the "you have a new invoice" email to all active parents in
// the invoice's family. Uses the school's per-school sender override
// when set (so Wooster parents see it from noreply@woomontessori.org).

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';

const PARENT_PORTAL_BASE = process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app';

interface SendArgs {
  invoiceId: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  school_id: string;
  family_id: string | null;
  responsible_parent_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_ghl_contact_id: string | null;
  public_pay_token: string | null;
  title: string;
  description: string | null;
  total_cents: number;
  due_at: string;
}

export interface SendResult {
  sent_to: string[];
  skipped: string[];
  // True when the Growth Suite workflow webhook (invoice.sent) fired —
  // the primary delivery channel when a school has it configured.
  ghl_notified: boolean;
}

export async function sendInvoiceEmail({ invoiceId }: SendArgs): Promise<SendResult> {
  const { rows: invRows } = await query<InvoiceRow>(
    `SELECT id, invoice_number, school_id, family_id, responsible_parent_id,
            recipient_name, recipient_email, recipient_ghl_contact_id,
            public_pay_token, title, description, total_cents, due_at
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const inv = invRows[0];
  if (!inv) throw new Error('Invoice not found');

  const { rows: schoolRows } = await query<{ name: string; ghl_location_id: string | null }>(
    `SELECT name, ghl_location_id FROM schools WHERE id = $1`, [inv.school_id],
  );
  const schoolName = schoolRows[0]?.name ?? 'your school';
  const ghlLocationId = schoolRows[0]?.ghl_location_id ?? '';

  // Resolve the primary contact + email recipients. For a family it's
  // the active parents (primary first); for an arbitrary contact it's
  // the inline recipient fields.
  let recipients: string[] = [];
  let contact = {
    first_name: '', last_name: '', email: '', phone: '', ghl_contact_id: '',
  };
  if (inv.family_id) {
    const { rows: allParents } = await query<{
      id: string;
      first_name: string; last_name: string; email: string | null; phone: string | null;
      ghl_contact_id: string | null; is_primary: boolean;
    }>(
      `SELECT id, first_name, last_name, email, phone, ghl_contact_id, is_primary
         FROM parents
        WHERE family_id = $1 AND school_id = $2 AND status = 'active'
        ORDER BY is_primary DESC, created_at ASC`,
      [inv.family_id, inv.school_id],
    );
    // When the operator picked who the bill goes to (split households,
    // "grandma pays for this one"), deliver ONLY to that parent — they
    // are also the workflow contact. Otherwise: all active parents,
    // primary as contact.
    const responsible = inv.responsible_parent_id
      ? allParents.find((p) => p.id === inv.responsible_parent_id)
      : undefined;
    const parents = responsible ? [responsible] : allParents;
    recipients = parents.map((p) => p.email).filter((e): e is string => !!e);
    const primary = parents[0];
    if (primary) {
      contact = {
        first_name: primary.first_name ?? '', last_name: primary.last_name ?? '',
        email: primary.email ?? '', phone: primary.phone ?? '',
        ghl_contact_id: primary.ghl_contact_id ?? '',
      };
    }
  } else {
    recipients = inv.recipient_email ? [inv.recipient_email] : [];
    const parts = (inv.recipient_name ?? '').trim().split(/\s+/);
    contact = {
      first_name: parts[0] ?? '', last_name: parts.slice(1).join(' '),
      email: inv.recipient_email ?? '', phone: '',
      ghl_contact_id: inv.recipient_ghl_contact_id ?? '',
    };
  }

  // Public tokenized link — works for both family + non-family
  // recipients with no portal login required.
  const payUrl = inv.public_pay_token
    ? `${PARENT_PORTAL_BASE}/pay/invoice/${inv.id}?t=${inv.public_pay_token}`
    : `${PARENT_PORTAL_BASE}/billing/pay/${inv.id}`;
  const amount = (inv.total_cents / 100).toFixed(2);
  const dueLabel = new Date(inv.due_at).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // ── Growth Suite workflow webhook (invoice.sent) ──────────────────
  // Primary delivery channel when the school has it configured: the
  // school designs the "new invoice" email in their Growth Suite
  // workflow. Same webhook URL + flat-payload shape as payment
  // receipts; the workflow branches on `event`. Fire-and-forget.
  let ghlNotified = false;
  const { rows: cfgRows } = await query<{ url: string | null }>(
    `SELECT ghl_receipt_webhook_url AS url FROM school_payment_config WHERE school_id = $1`,
    [inv.school_id],
  );
  const webhookUrl = cfgRows[0]?.url ?? null;
  if (webhookUrl) {
    const payload = {
      event: 'invoice.sent',
      contact_id: contact.ghl_contact_id,
      email: contact.email,
      phone: contact.phone,
      first_name: contact.first_name,
      last_name: contact.last_name,
      amount_formatted: `$${amount}`,
      amount_cents: inv.total_cents,
      invoice_number: inv.invoice_number,
      invoice_title: inv.title,
      invoice_description: inv.description ?? '',
      due_date: dueLabel,
      due_date_iso: new Date(inv.due_at).toISOString(),
      pay_url: payUrl,
      school_name: schoolName,
      // present-but-empty so one workflow can map a single field set
      // across invoice.sent / payment.succeeded / payment.failed
      card_summary: '',
      payment_date: '',
      failure_reason: '',
      school_id: inv.school_id,
      ghl_location_id: ghlLocationId,
    };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrowthSuite-InvoiceWebhook/1' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        ghlNotified = res.ok;
        if (!res.ok) console.warn(`[send-invoice-email] webhook returned ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      console.warn('[send-invoice-email] webhook failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const subject = `New invoice from ${schoolName}: ${inv.title} ($${amount})`;

  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px; font-size: 20px;">New invoice from ${escape(schoolName)}</h2>
  <p style="margin: 0 0 16px; font-size: 14px; color: #6b7280;">Invoice ${escape(inv.invoice_number)}</p>

  <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0;">
    <h3 style="margin: 0 0 4px; font-size: 16px;">${escape(inv.title)}</h3>
    ${inv.description ? `<p style="margin: 4px 0 12px; font-size: 13px; color: #6b7280;">${escape(inv.description)}</p>` : ''}
    <div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 14px;">
      <span style="color: #6b7280;">Amount due</span>
      <span style="font-weight: 600; font-size: 18px;">$${amount}</span>
    </div>
    <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 13px;">
      <span style="color: #6b7280;">Due by</span>
      <span>${escape(dueLabel)}</span>
    </div>
  </div>

  <p style="margin: 16px 0;">
    <a href="${payUrl}" style="display: inline-block; background: #1F1F1F; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
      View &amp; pay invoice
    </a>
  </p>

  <p style="margin: 16px 0 0; font-size: 12px; color: #6b7280;">
    You can pay by card or by bank account (ACH). All payments are processed securely through Stripe.
  </p>
  <p style="margin: 8px 0 0; font-size: 11px; color: #9ca3af; word-break: break-all;">
    Or copy this link: ${payUrl}
  </p>
</body></html>
  `.trim();

  const text = `New invoice from ${schoolName}

${inv.invoice_number} · ${inv.title}
${inv.description ? `\n${inv.description}\n` : ''}
Amount due: $${amount}
Due by: ${dueLabel}

View and pay: ${payUrl}

You can pay by card or by bank account (ACH). All payments processed securely through Stripe.`;

  const sentTo: string[] = [];
  const skipped: string[] = [];
  for (const email of recipients) {
    try {
      await sendBrandedEmail({ to: email, schoolId: inv.school_id, subject, html, text });
      sentTo.push(email);
    } catch (err) {
      console.error('[send-invoice-email] failed for', email, ':', err);
      skipped.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { sent_to: sentTo, skipped, ghl_notified: ghlNotified };
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}
