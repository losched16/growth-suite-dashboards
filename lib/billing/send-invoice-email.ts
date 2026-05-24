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
  family_id: string;
  title: string;
  description: string | null;
  total_cents: number;
  due_at: string;
}

interface ParentRow {
  email: string;
  first_name: string;
  last_name: string;
}

export interface SendResult {
  sent_to: string[];
  skipped: string[];
}

export async function sendInvoiceEmail({ invoiceId }: SendArgs): Promise<SendResult> {
  const { rows: invRows } = await query<InvoiceRow>(
    `SELECT id, invoice_number, school_id, family_id, title, description,
            total_cents, due_at
       FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  const inv = invRows[0];
  if (!inv) throw new Error('Invoice not found');

  const { rows: schoolRows } = await query<{ name: string }>(
    `SELECT name FROM schools WHERE id = $1`, [inv.school_id],
  );
  const schoolName = schoolRows[0]?.name ?? 'your school';

  const { rows: parents } = await query<ParentRow>(
    `SELECT email, first_name, last_name FROM parents
      WHERE family_id = $1 AND school_id = $2 AND status = 'active' AND email IS NOT NULL`,
    [inv.family_id, inv.school_id],
  );

  if (parents.length === 0) {
    return { sent_to: [], skipped: ['no_parents_with_email'] };
  }

  const payUrl = `${PARENT_PORTAL_BASE}/billing/pay/${inv.id}`;
  const amount = (inv.total_cents / 100).toFixed(2);
  const dueLabel = new Date(inv.due_at).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

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
  for (const p of parents) {
    try {
      await sendBrandedEmail({
        to: p.email,
        schoolId: inv.school_id,
        subject,
        html,
        text,
      });
      sentTo.push(p.email);
    } catch (err) {
      console.error('[send-invoice-email] failed for', p.email, ':', err);
      skipped.push(`${p.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { sent_to: sentTo, skipped };
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '&' ? '&amp;' :
    c === '"' ? '&quot;' :
    '&#39;');
}
