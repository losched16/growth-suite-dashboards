// Onboarding emails: send a school its link, and nudge stalled schools. Uses
// the shared sendBrandedEmail (schoolId null → generic Growth Suite sender,
// which is right for pre-tenant leads). Links are absolute (built from
// APP_BASE_URL) because these send from routes/crons without a request host.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { mintOnboardingToken } from './token';

function appBase(): string {
  return (
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://growth-suite-dashboards.vercel.app'
  ).replace(/\/$/, '');
}

export function onboardingLink(onboardingId: string): string {
  return `${appBase()}/onboarding/${mintOnboardingToken(onboardingId)}`;
}

interface OnboardingContact {
  school_id: string | null;
  school_name: string;
  contact_email: string;
  contact_name: string | null;
}

async function loadContact(onboardingId: string): Promise<OnboardingContact | null> {
  const { rows } = await query<OnboardingContact>(
    `SELECT school_id, school_name, contact_email, contact_name
       FROM school_onboarding WHERE id = $1`,
    [onboardingId],
  );
  return rows[0] ?? null;
}

// Send the initial "here's your setup link" email.
export async function sendOnboardingLinkEmail(onboardingId: string): Promise<boolean> {
  const c = await loadContact(onboardingId);
  if (!c) return false;
  const link = onboardingLink(onboardingId);
  const hi = c.contact_name ? c.contact_name.split(' ')[0] : 'there';

  await sendBrandedEmail({
    to: c.contact_email,
    schoolId: c.school_id,
    subject: `Let’s get ${c.school_name} set up on Growth Suite`,
    html: `<p>Hi ${hi},</p>
<p>Welcome! We’ve started setting up <strong>${c.school_name}</strong>. Use your private onboarding page to submit a few things and track your progress — no password needed.</p>
<p><a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your onboarding page</a></p>
<p>You’ll be asked for your grade levels, programs, schedules, your student roster file, and your logo. The page shows what’s done and what’s still needed.</p>
<p>Warmly,<br/>The Growth Suite team</p>`,
    text: `Hi ${hi},\n\nWelcome! We’ve started setting up ${c.school_name}. Use your private onboarding page to submit a few things and track your progress — no password needed:\n\n${link}\n\nYou’ll be asked for your grade levels, programs, schedules, student roster file, and logo.\n\nWarmly,\nThe Growth Suite team`,
  });
  return true;
}

// Send a reminder with the count of what's still outstanding.
export async function sendOnboardingReminderEmail(onboardingId: string, outstanding: number): Promise<boolean> {
  const c = await loadContact(onboardingId);
  if (!c) return false;
  const link = onboardingLink(onboardingId);
  const hi = c.contact_name ? c.contact_name.split(' ')[0] : 'there';
  const n = `${outstanding} item${outstanding === 1 ? '' : 's'}`;

  await sendBrandedEmail({
    to: c.contact_email,
    schoolId: c.school_id,
    subject: `${outstanding} thing${outstanding === 1 ? '' : 's'} left to set up ${c.school_name}`,
    html: `<p>Hi ${hi},</p>
<p>Just a friendly nudge — <strong>${c.school_name}</strong> has <strong>${n}</strong> still to complete before we can finish your setup.</p>
<p><a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Pick up where you left off</a></p>
<p>Warmly,<br/>The Growth Suite team</p>`,
    text: `Hi ${hi},\n\nJust a friendly nudge — ${c.school_name} has ${n} still to complete before we can finish your setup:\n\n${link}\n\nWarmly,\nThe Growth Suite team`,
  });
  return true;
}
