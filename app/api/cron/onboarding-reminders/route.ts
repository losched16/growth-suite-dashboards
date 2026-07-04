// GET/POST /api/cron/onboarding-reminders — nightly. For every onboarding:
//   1. recompute progress and persist percent_complete + stage (so the ops
//      board reads fresh values without recomputing per row);
//   2. if the school still has actionable items, isn't brand-new, and hasn't
//      been reminded recently, email a nudge.
//
// Auth: Bearer CRON_SECRET (what Vercel cron sends) or INTERNAL_API_TOKEN.
// Fails closed — same pattern as sync-all.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { query } from '@/lib/db';
import { computeOnboarding } from '@/lib/onboarding/status';
import { sendOnboardingReminderEmail } from '@/lib/onboarding/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const GRACE_DAYS = 2;        // don't nudge in the first couple days after creating
const REMIND_EVERY_DAYS = 4; // cadence between nudges

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length).trim();
  const candidates = [process.env.CRON_SECRET, process.env.INTERNAL_API_TOKEN]
    .filter((s): s is string => !!s && s.length > 0);
  for (const expected of candidates) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

async function run(): Promise<NextResponse> {
  const { rows } = await query<{ id: string; created_at: string; last_reminded_at: string | null }>(
    `SELECT id, created_at, last_reminded_at FROM school_onboarding`,
  );

  let recomputed = 0, reminded = 0, skipped = 0;
  const nowMs = Date.now();

  for (const r of rows) {
    const snap = await computeOnboarding(r.id);
    if (!snap) { skipped++; continue; }

    // 1. Persist fresh progress.
    await query(
      `UPDATE school_onboarding SET percent_complete = $2, stage = $3, last_status_at = now() WHERE id = $1`,
      [r.id, snap.percentComplete, snap.stage],
    );
    recomputed++;

    // 2. Reminder eligibility.
    const outstanding = snap.tasks.filter((t) => t.owner === 'school' && t.status === 'not_started').length;
    if (outstanding === 0 || snap.stage === 'live') continue;

    const ageDays = (nowMs - new Date(r.created_at).getTime()) / 86_400_000;
    if (ageDays < GRACE_DAYS) continue;

    const sinceReminderDays = r.last_reminded_at
      ? (nowMs - new Date(r.last_reminded_at).getTime()) / 86_400_000
      : Infinity;
    if (sinceReminderDays < REMIND_EVERY_DAYS) continue;

    try {
      await sendOnboardingReminderEmail(r.id, outstanding);
      await query(`UPDATE school_onboarding SET last_reminded_at = now() WHERE id = $1`, [r.id]);
      reminded++;
    } catch (e) {
      // A single email failure shouldn't abort the whole run.
      console.error('[onboarding-reminders] send failed for', r.id, e);
    }
  }

  return NextResponse.json({ ok: true, total: rows.length, recomputed, reminded, skipped });
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return run();
}
export async function POST(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return run();
}
