// Per-school financial aid settings loader + types.
//
// Both repos (dashboards + parent portal) read FA settings through
// this shape. The parent portal's settings loader is a tiny copy
// living in lib/financial-aid/settings.ts there — keep this and that
// file structurally identical when adding columns.

import { query } from '@/lib/db';

export interface FinancialAidSettings {
  school_id: string;
  is_enabled: boolean;
  active_academic_year: string;
  application_open: boolean;
  application_deadline: string | null;             // 'YYYY-MM-DD'
  intro_copy_markdown: string | null;
  required_document_types: string[];
  max_award_per_student_cents: number;
  admin_notify_emails: string[];
  decision_letter_template: string | null;
  signature_name: string | null;
  signature_title: string | null;
}

// Sensible legacy defaults — applied when a school has no row yet.
// Defaults mirror the hardcoded values the platform shipped with
// before migration 045 so existing tenants don't break overnight.
export const LEGACY_FA_DEFAULTS: FinancialAidSettings = {
  school_id: '',
  is_enabled: false,                  // off by default per onboarding policy
  active_academic_year: '2026-27',
  application_open: true,
  application_deadline: null,
  intro_copy_markdown: null,
  required_document_types: [],
  max_award_per_student_cents: 5_000_000,
  admin_notify_emails: [],
  decision_letter_template: null,
  signature_name: null,
  signature_title: null,
};

// Returns the school's settings row, or the legacy defaults (with
// is_enabled=false) when no row exists.
export async function getFinancialAidSettings(schoolId: string): Promise<FinancialAidSettings> {
  const { rows } = await query<FinancialAidSettings>(
    `SELECT school_id, is_enabled, active_academic_year,
            application_open,
            to_char(application_deadline, 'YYYY-MM-DD') AS application_deadline,
            intro_copy_markdown, required_document_types,
            max_award_per_student_cents, admin_notify_emails,
            decision_letter_template, signature_name, signature_title
       FROM school_financial_aid_settings WHERE school_id = $1`,
    [schoolId],
  );
  if (rows.length === 0) return { ...LEGACY_FA_DEFAULTS, school_id: schoolId };
  return rows[0];
}

// Catalog of canonical document types parents may be asked to upload.
// Source-of-truth for the admin "required documents" picker and the
// parent-portal upload UI. Each key maps to a friendly label + a hint
// about what acceptable proof looks like.
export const FA_DOCUMENT_CATALOG: Array<{ key: string; label: string; hint: string }> = [
  { key: 'tax_return',       label: 'Federal tax return (1040)', hint: "Most recent year. All pages, including schedules." },
  { key: 'w2',               label: 'W-2 form(s)',                hint: "All employers for the most recent tax year." },
  { key: 'pay_stubs',        label: 'Recent pay stubs',           hint: "Last 2 months from every working adult in the household." },
  { key: 'ssa_statement',    label: 'Social Security statement',  hint: 'If anyone in the household receives SSA / SSI / disability.' },
  { key: 'unemployment',     label: 'Unemployment benefit letter',hint: 'If anyone is on unemployment in the application year.' },
  { key: 'self_employed',    label: 'Schedule C / business returns', hint: 'For self-employed parents — most recent year.' },
  { key: 'bank_statement',   label: 'Bank statement',             hint: 'Last 2 months from all checking + savings accounts.' },
  { key: 'investment_summary', label: 'Investment / 401(k) summary', hint: 'Most recent statements for any non-retirement investments.' },
  { key: 'mortgage_statement', label: 'Mortgage statement',       hint: 'Most recent statement showing balance + payment.' },
  { key: 'rent_lease',       label: 'Lease / rent receipts',      hint: 'If renting — current lease or recent payment proof.' },
  { key: 'medical_expenses', label: 'Documented medical expenses', hint: 'For families claiming significant out-of-pocket medical bills.' },
  { key: 'child_support',    label: 'Child support order',        hint: 'Custody / support paperwork showing payments paid or received.' },
  { key: 'other',            label: 'Other supporting documents', hint: "Anything else you'd like the FA committee to see." },
];
