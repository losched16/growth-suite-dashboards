// Office notification email renderer — shared between the parent-portal
// real-submit fan-out (lives in growth-suite-parent-portal/lib/forms/
// post-submit-effects.ts) and the dashboards-repo "Send test email to
// me" button.
//
// Keeping the markup here in the dashboards repo means staff see the
// EXACT same email body via the test-mode "send to me" button as a
// real office recipient gets in production. The two copies must be
// kept structurally identical — when you tweak one, tweak the other.

export interface RenderOpts {
  formDisplayName: string;
  schoolName: string;
  submissionId: string;
  familyLabel: string;
  studentLabel: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  responses: Record<string, unknown>;
  isTest?: boolean;
}

export function renderNotificationEmail(opts: RenderOpts): {
  subject: string;
  html: string;
  text: string;
} {
  const testTag = opts.isTest ? ' [TEST]' : '';
  const subject = `New ${opts.formDisplayName} submission${testTag} — ${opts.familyLabel}`;

  const responsePairs = Object.entries(opts.responses)
    .filter(([k]) => !k.startsWith('__'))
    .slice(0, 40);

  const rowsHtml = responsePairs
    .map(([k, v]) => `<tr><td style="padding:4px 8px;font-family:monospace;color:#475569;font-size:11px;border-bottom:1px solid #f1f5f9;">${escape(k)}</td><td style="padding:4px 8px;border-bottom:1px solid #f1f5f9;">${escape(formatValue(v))}</td></tr>`)
    .join('');

  const testBanner = opts.isTest
    ? `<div style="background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;padding:8px 12px;border-radius:6px;font-size:12px;margin:0 0 12px;">
         <strong>TEST EMAIL</strong> — this was triggered by staff from the form preview. Real parents did not submit anything.
       </div>`
    : '';

  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;">
  ${testBanner}
  <h2 style="margin:0 0 8px;">${escape(opts.formDisplayName)} &mdash; new submission</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px;">
    A parent just submitted the <strong>${escape(opts.formDisplayName)}</strong> form for <strong>${escape(opts.schoolName)}</strong>.
  </p>

  <h3 style="margin:16px 0 4px;font-size:13px;color:#0f172a;">Family</h3>
  <table style="font-size:13px;color:#0f172a;border-collapse:collapse;">
    <tr><td style="padding:2px 8px;color:#64748b;">Family</td><td style="padding:2px 8px;">${escape(opts.familyLabel)}</td></tr>
    ${opts.studentLabel ? `<tr><td style="padding:2px 8px;color:#64748b;">Student</td><td style="padding:2px 8px;">${escape(opts.studentLabel)}</td></tr>` : ''}
    ${opts.parentEmail ? `<tr><td style="padding:2px 8px;color:#64748b;">Parent email</td><td style="padding:2px 8px;"><a href="mailto:${escape(opts.parentEmail)}">${escape(opts.parentEmail)}</a></td></tr>` : ''}
    ${opts.parentPhone ? `<tr><td style="padding:2px 8px;color:#64748b;">Parent phone</td><td style="padding:2px 8px;">${escape(opts.parentPhone)}</td></tr>` : ''}
  </table>

  <h3 style="margin:24px 0 4px;font-size:13px;color:#0f172a;">Responses</h3>
  <table style="font-size:12px;color:#0f172a;border-collapse:collapse;width:100%;border:1px solid #e2e8f0;border-radius:4px;">
    ${rowsHtml || '<tr><td style="padding:8px;color:#94a3b8;">(no fields filled)</td></tr>'}
  </table>

  <p style="margin:24px 0 0;font-size:12px;color:#94a3b8;">
    Submission ID <code>${escape(opts.submissionId)}</code>
  </p>
</body></html>`.trim();

  const textPairs = responsePairs.map(([k, v]) => `${k}: ${formatValue(v)}`).join('\n');
  const text = [
    opts.isTest ? '*** TEST EMAIL — no real parent submitted ***' : null,
    `${opts.formDisplayName} — new submission`,
    '',
    `School: ${opts.schoolName}`,
    `Family: ${opts.familyLabel}`,
    opts.studentLabel ? `Student: ${opts.studentLabel}` : null,
    opts.parentEmail ? `Parent email: ${opts.parentEmail}` : null,
    opts.parentPhone ? `Parent phone: ${opts.parentPhone}` : null,
    '',
    'Responses:',
    textPairs,
    '',
    `Submission ID: ${opts.submissionId}`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : v.map(String).join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v.startsWith('data:') ? '(data URL — signature/file)' : v;
  return String(v);
}

function escape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
