// GET  /api/admin/schools/{schoolId}/financial-aid/settings  → load
// PUT  /api/admin/schools/{schoolId}/financial-aid/settings  → upsert
//
// Operator-only (uses the same SESSION_COOKIE the rest of /admin
// pages check). Stores the row in school_financial_aid_settings.
// Upsert keyed by (school_id) so re-saving updates in place.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { getFinancialAidSettings, LEGACY_FA_DEFAULTS } from '@/lib/financial-aid/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

async function requireOperator() {
  const ck = await cookies();
  return verifySessionToken(ck.get(SESSION_COOKIE)?.value);
}

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  if (!(await requireOperator())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { schoolId } = await params;
  const settings = await getFinancialAidSettings(schoolId);
  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest, { params }: { params: Params }) {
  if (!(await requireOperator())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { schoolId } = await params;

  const body = await request.json().catch(() => null) as Partial<typeof LEGACY_FA_DEFAULTS> | null;
  if (!body) return NextResponse.json({ error: 'bad_body' }, { status: 400 });

  // Light validation — clamp / sanitize. Most of the work is at the
  // client form layer so we keep this defensive.
  const isEnabled = body.is_enabled === true;
  const academicYear = typeof body.active_academic_year === 'string' && /^\d{4}-\d{2}$/.test(body.active_academic_year)
    ? body.active_academic_year
    : LEGACY_FA_DEFAULTS.active_academic_year;
  const applicationOpen = body.application_open !== false;            // defaults true
  const deadline = typeof body.application_deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.application_deadline)
    ? body.application_deadline
    : null;
  const intro = typeof body.intro_copy_markdown === 'string' ? body.intro_copy_markdown.slice(0, 10_000) : null;
  const requiredDocs = Array.isArray(body.required_document_types)
    ? body.required_document_types.map(String).filter((s) => /^[a-z_]+$/.test(s)).slice(0, 30)
    : [];
  const maxCents = Number.isFinite(body.max_award_per_student_cents as number) && (body.max_award_per_student_cents as number) > 0
    ? Math.min(Math.floor(body.max_award_per_student_cents as number), 100_000_000)
    : LEGACY_FA_DEFAULTS.max_award_per_student_cents;
  const adminEmails = Array.isArray(body.admin_notify_emails)
    ? body.admin_notify_emails.map(String).map((s) => s.trim().toLowerCase()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)).slice(0, 20)
    : [];
  const letterTpl = typeof body.decision_letter_template === 'string'
    ? body.decision_letter_template.slice(0, 20_000) : null;
  const sigName  = typeof body.signature_name  === 'string' ? body.signature_name.trim().slice(0, 120) || null : null;
  const sigTitle = typeof body.signature_title === 'string' ? body.signature_title.trim().slice(0, 120) || null : null;
  // Policy caps + COL. Clamp percentages to [0, 1] (we store as a
  // fraction not a 0-100 percent) and the COL multiplier to a
  // reasonable [0.5, 2.5] window so a stray "150" can't break math.
  function clampPct(v: unknown): number | null {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n > 1.5) return null; // probably a typo (someone wrote 50 instead of 0.5)
    return Math.min(1, n);
  }
  const maxAwardPct = clampPct(body.max_award_pct_of_tuition);
  const minFamilyPct = clampPct(body.min_family_contribution_pct);
  const policyNotes = typeof body.policy_notes === 'string'
    ? body.policy_notes.slice(0, 5000) : null;
  let colMult = Number(body.regional_col_multiplier);
  if (!Number.isFinite(colMult) || colMult <= 0) colMult = 1.0;
  colMult = Math.min(2.5, Math.max(0.5, colMult));
  const colLabel = typeof body.regional_col_label === 'string'
    ? body.regional_col_label.trim().slice(0, 200) || null : null;

  await query(
    `INSERT INTO school_financial_aid_settings
       (school_id, is_enabled, active_academic_year, application_open,
        application_deadline, intro_copy_markdown,
        required_document_types, max_award_per_student_cents,
        admin_notify_emails, decision_letter_template,
        signature_name, signature_title,
        max_award_pct_of_tuition, min_family_contribution_pct,
        policy_notes, regional_col_multiplier, regional_col_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9::text[],$10,$11,$12,
             $13,$14,$15,$16,$17)
     ON CONFLICT (school_id) DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       active_academic_year = EXCLUDED.active_academic_year,
       application_open = EXCLUDED.application_open,
       application_deadline = EXCLUDED.application_deadline,
       intro_copy_markdown = EXCLUDED.intro_copy_markdown,
       required_document_types = EXCLUDED.required_document_types,
       max_award_per_student_cents = EXCLUDED.max_award_per_student_cents,
       admin_notify_emails = EXCLUDED.admin_notify_emails,
       decision_letter_template = EXCLUDED.decision_letter_template,
       signature_name = EXCLUDED.signature_name,
       signature_title = EXCLUDED.signature_title,
       max_award_pct_of_tuition = EXCLUDED.max_award_pct_of_tuition,
       min_family_contribution_pct = EXCLUDED.min_family_contribution_pct,
       policy_notes = EXCLUDED.policy_notes,
       regional_col_multiplier = EXCLUDED.regional_col_multiplier,
       regional_col_label = EXCLUDED.regional_col_label,
       updated_at = now()`,
    [schoolId, isEnabled, academicYear, applicationOpen, deadline, intro,
     requiredDocs, maxCents, adminEmails, letterTpl, sigName, sigTitle,
     maxAwardPct, minFamilyPct, policyNotes, colMult, colLabel],
  );

  return NextResponse.json({ ok: true });
}
