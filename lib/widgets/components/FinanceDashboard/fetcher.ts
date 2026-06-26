// Finance data fetcher. Reads student.metadata for every monetary field
// the sync captures, computes rollups, breakdowns, and recipient lists.
//
// ALL FIGURES = CONTRACTED amounts (what the school is owed). Actual
// cash received / A/R / bank balances need a separate integration with
// the payment processor — surfaced as a "coming soon" panel in the UI.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { FinanceDashboardConfig, ProgramGroup } from './config';

export interface ProgramBucket {
  label: string;
  count: number;
  tuition: number;
}

export interface ServiceBucket {
  label: string;
  count: number;
  revenue: number;
}

export interface RecipientRow {
  name: string;
  sub: string;
  amount: number;
}

// Live cash data drawn from our own invoices + payments tables (the
// native side). This is the source of truth for tenants on the new
// stack (MCH and forward). DGM may have BOTH FactsActuals (legacy CSV
// imports for prior terms) AND LivePayments (current term via the
// portal) — the index renders both side-by-side when both exist.
export interface LivePayments {
  has_data: boolean;
  // Aggregated invoice counts
  total_invoices: number;
  open_invoices: number;
  paid_invoices: number;
  partially_paid_invoices: number;
  voided_invoices: number;
  // Aggregated cents
  total_billed_cents: number;        // SUM(total_cents) across non-voided
  total_paid_cents: number;          // SUM(amount_paid_cents)
  total_outstanding_cents: number;   // total_billed - total_paid
  // Live tuition enrollments aggregate (gives us "contracted revenue for
  // the year" even before invoices have been generated for every month).
  active_enrollments: number;
  total_annual_contracted_cents: number;
}

export interface FactsActuals {
  term: string;
  has_data: boolean;
  rows: number;            // # balance rows for that term
  matched_to_students: number;
  charges: number;         // total charged this term
  credits: number;         // total credits/discounts applied
  payments: number;        // total cash received
  amount_due: number;      // total A/R outstanding
  credit_balance: number;  // total credit balances on file
  delinquent_balance: number;
  ar_buckets: {
    paid_in_full: number;
    owes_under_500: number;
    owes_500_2000: number;
    owes_2000_5000: number;
    owes_over_5000: number;
    delinquent_count: number;
  };
  top_delinquent: Array<{
    customer_name: string;
    student_name: string;
    charges: number;
    payments: number;
    amount_due: number;
    delinquent_balance: number;
    matched_family_id: string | null;
  }>;
  imported_at: string | null;
}

// One row per active student for the "Students & Families" tab: their
// FACTS charged / paid / remaining (the actual cash position) plus their
// Growth Suite plan + go-forward schedule, so the CFO sees payment
// progress per family in one place.
export interface StudentProgressRow {
  student_id: string;
  // Canonical GHL contact Student ID (metadata.unique_id) — the SAME id the
  // student roster shows, so the two hubs reconcile. The FACTS account number
  // (in accounts[]) is a separate legacy reference kept for FACTS matching.
  unique_id: string | null;
  student_name: string;
  family: string;
  family_id: string | null;
  program: string;
  plan: string;
  charged: number;        // FACTS charges (dollars)
  credits: number;        // discounts/credits applied
  paid: number;           // cash collected in FACTS
  balance: number;        // remaining owed
  pct_paid: number;       // 0–100 of net
  gs_installments: number;
  gs_scheduled: number;   // total scheduled in GS plan (dollars)
  gs_first_due: string | null;
  // Drill-down detail (rendered in the inline accordion).
  accounts: Array<{ account: string; charged: number; credit: number; paid: number; balance: number }>;
  schedule: Array<{ label: string; due: string | null; amount: number; status: string; paid: number; kind?: 'tuition' | 'fee' }>;
}

// One FACTS ledger line for the "Transactions" tab — every debit/credit/
// payment, by account, filterable.
export interface TransactionRow {
  student_name: string;
  family: string;
  family_id: string | null;
  account: string;
  account_key: string;
  charged: number;
  credit: number;
  paid: number;
  balance: number;
}

export interface FinanceData {
  // Active tab + filter state (drives the tabbed Finance Hub).
  fin_tab: 'overview' | 'students' | 'transactions';
  q: string;
  acct: string;
  status: string;
  // Audience filter: 'enrolled' (default, matches the roster's 256) or 'all'
  // active. Demo/test students are always excluded regardless.
  enr: 'enrolled' | 'all';
  // Per-tab payloads (only the active tab's is populated).
  students: StudentProgressRow[] | null;
  transactions: TransactionRow[] | null;
  account_options: Array<{ key: string; label: string }>;
  // Top-line cards
  total_revenue: number;
  total_discounts: number;
  total_aid_credits: number;
  net_revenue: number;
  student_count: number;
  // Actual cash data from FACTS (null if no import yet)
  facts: FactsActuals | null;
  // Live cash data from our own invoices + payments tables (null when no
  // invoices have been generated yet for this school). Independent of
  // FactsActuals — a tenant on the native stack will have live_payments
  // populated and facts NULL; a tenant who imported old FACTS terms can
  // see both.
  live_payments: LivePayments | null;

  // Tuition by program
  by_program: ProgramBucket[];
  total_tuition: number;

  // Other revenue lines
  enrollment_fee: number;
  admin_fee: number;
  extended_day: number;
  lunch: number;
  sst: number;
  enrichments_total: number;
  sports_total: number;
  late_fees: number;

  // Discounts
  employee_discount: number;
  annual_discount: number;
  sibling_discount: number;

  // Aid + credits
  financial_aid: number;
  referral_credit: number;
  esa: number;
  sto_orig: number;
  sto_switcher: number;
  sto_corp: number;
  sto_other: number;

  // Breakdowns
  by_enrichment: ServiceBucket[];
  by_sport: ServiceBucket[];

  // Recipient lists
  fin_aid_recipients: RecipientRow[];
  esa_recipients: RecipientRow[];
  sto_recipients: RecipientRow[];
}

interface DbStudent {
  metadata: Record<string, unknown> | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  primary_parent_name: string | null;
  // Native bridge columns. When a student has an active enrollment in
  // family_tuition_enrollments (the new tuition system), these come back
  // populated. When NULL, fall back to student.metadata (legacy DGM
  // path). Joining via LEFT JOIN so legacy students remain unaffected.
  enr_annual_tuition_cents: number | null;
  enr_program_label: string | null;
}

function mdNum(s: Record<string, unknown> | null, key: string): number {
  if (!s) return 0;
  const v = s[key];
  if (v === null || v === undefined) return 0;
  const cleaned = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(cleaned) ? cleaned : 0;
}

function mdStr(s: Record<string, unknown> | null, key: string): string {
  if (!s) return '';
  const v = s[key];
  if (v === null || v === undefined) return '';
  const str = typeof v === 'string' ? v : String(v);
  return str.trim();
}

function ynActive(s: string): boolean {
  if (!s) return false;
  const v = s.trim().toLowerCase();
  return !!v && !['no', 'none', 'n/a', 'na', '0', 'false'].includes(v);
}

function pickProgramGroup(programName: string, groups: ProgramGroup[]): string {
  if (!programName) return 'Unassigned';
  const lc = programName.toLowerCase();
  for (const g of groups) {
    for (const pat of g.match_patterns) {
      if (lc.includes(pat.toLowerCase())) return g.label;
    }
  }
  return 'Other';
}

const FINANCE_YEAR = '2026-27';

export async function fetcher(
  school: SchoolContext,
  config: FinanceDashboardConfig,
  searchParams?: WidgetSearchParams,
): Promise<FinanceData> {
  const groups = config.program_groups ?? [];
  const tabRaw = (searchParams?.fintab ?? 'overview').trim();
  const fin_tab: FinanceData['fin_tab'] =
    tabRaw === 'students' ? 'students' : tabRaw === 'transactions' ? 'transactions' : 'overview';
  const q = (searchParams?.q ?? '').trim();
  const acct = (searchParams?.acct ?? '').trim();
  const status = (searchParams?.status ?? '').trim();
  // Audience filter: 'enrolled' (default) restricts to students with an
  // active academic enrollment for the year — the SAME signal the Student
  // Roster uses, so the Finance hub matches it (256, not 287). 'all' shows
  // every active student. Test/demo students are ALWAYS excluded.
  const enrolledOnly = (searchParams?.enr ?? 'enrolled').trim() !== 'all';

  // Bridge JOIN: pull the active enrollment + grid program label so the
  // widget surfaces native-tuition data when student.metadata is empty.
  // LEFT JOIN means legacy DGM students (who have metadata.tuition_fee
  // but no row in family_tuition_enrollments) still come back with all
  // their metadata intact — those JOIN columns are NULL and the legacy
  // path takes over. Native MCH students (enrollments populated but
  // metadata.tuition_fee = 0) get the JOIN columns filled and the
  // bridge below uses them.
  const { rows } = await query<DbStudent>(
    `SELECT
       s.metadata, s.first_name, s.last_name, s.preferred_name,
       (SELECT first_name || ' ' || last_name FROM parents pp
        WHERE pp.family_id = s.family_id AND pp.is_primary = true LIMIT 1) AS primary_parent_name,
       fte.annual_tuition_cents AS enr_annual_tuition_cents,
       g.program AS enr_program_label
     FROM students s
     LEFT JOIN family_tuition_enrollments fte
            ON fte.student_id = s.id
           AND fte.school_id = s.school_id
           AND fte.status = 'active'
     LEFT JOIN tuition_grids g ON g.id = fte.tuition_grid_id
     WHERE s.school_id = $1 AND s.status = 'active'
       AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
       AND ($2::boolean IS NOT TRUE OR EXISTS (
             SELECT 1 FROM enrollments e
              WHERE e.student_id = s.id AND e.academic_year = $3 AND e.status = 'enrolled'))`,
    [school.schoolId, enrolledOnly, FINANCE_YEAR],
  );

  let tuition = 0, extDay = 0, lunch = 0, admin = 0, enrollFee = 0;
  let svc1 = 0, svc2 = 0, sst = 0, lateFee = 0;
  let employeeDiscount = 0, annualDiscount = 0, siblingDiscount = 0, financialAid = 0;
  let referralCredit = 0, esa = 0, stoOrig = 0, stoSwitcher = 0, stoCorp = 0, stoOther = 0;

  const byProgram = new Map<string, ProgramBucket>();
  // Pre-seed configured groups so they always appear in order
  for (const g of groups) byProgram.set(g.label, { label: g.label, count: 0, tuition: 0 });
  const byEnrichment = new Map<string, ServiceBucket>();
  const bySport = new Map<string, ServiceBucket>();

  const finAidList: RecipientRow[] = [];
  const esaList: RecipientRow[] = [];
  const stoList: RecipientRow[] = [];

  for (const r of rows) {
    const m = r.metadata;
    // Empty-metadata fallback: when a school is on the native tuition
    // stack (no GHL metadata sync), `m` is null/empty. Treat as an
    // object so the metadata reads return 0 — the enrollment bridge
    // below supplies the tuition value.
    const md = m ?? {};

    // Native bridge: prefer the family_tuition_enrollments value when
    // present (annual_tuition_cents is cents → convert to dollars to
    // match metadata's dollar-denominated values). Otherwise fall back
    // to the legacy metadata.tuition_fee.
    const tFromMd = mdNum(md, 'tuition_fee');
    const tFromEnr = r.enr_annual_tuition_cents != null
      ? r.enr_annual_tuition_cents / 100
      : 0;
    const t = tFromEnr > 0 ? tFromEnr : tFromMd;

    const e = mdNum(md, 'extended_day_fee');
    const lu = mdNum(md, 'lunch_fee');
    const a = mdNum(md, 'admin_fee');
    const ef = mdNum(md, 'enrollment_fee');
    const s1 = mdNum(md, 'service_1_bill_amount');
    const s2 = mdNum(md, 'service_2_bill_amount');
    const sstF = mdNum(md, 'sst_fee');
    const lf = mdNum(md, 'late_fee');
    const ed = mdNum(md, 'employee_discount');
    const ad = mdNum(md, 'annual_discount');
    const sd = mdNum(md, 'sibling_discount');
    const fa = mdNum(md, 'financial_aid');
    const rc = mdNum(md, 'referral_credit');
    const esaAmt = mdNum(md, 'esa_amount');
    const stoAmt = mdNum(md, 'sto_amount');

    tuition += t;
    extDay += e;
    lunch += lu;
    admin += a;
    enrollFee += ef;
    svc1 += s1;
    svc2 += s2;
    sst += sstF;
    lateFee += lf;
    employeeDiscount += ed;
    annualDiscount += ad;
    siblingDiscount += sd;
    financialAid += fa;
    referralCredit += rc;
    esa += esaAmt;

    const stoType = mdStr(md, 'sto_type').toLowerCase();
    if (stoAmt > 0) {
      if (stoType.includes('orig')) stoOrig += stoAmt;
      else if (stoType.includes('switch')) stoSwitcher += stoAmt;
      else if (stoType.includes('corp')) stoCorp += stoAmt;
      else stoOther += stoAmt;
    }

    // By-program — prefer the native tuition_grids.program value when
    // present (MCH and forward); fall back to metadata.program for
    // legacy DGM-style data.
    const program = (r.enr_program_label && r.enr_program_label.trim()) || mdStr(md, 'program');
    const groupLabel = pickProgramGroup(program, groups);
    if (!byProgram.has(groupLabel)) byProgram.set(groupLabel, { label: groupLabel, count: 0, tuition: 0 });
    const bp = byProgram.get(groupLabel)!;
    bp.count++;
    bp.tuition += t;

    // By enrichment / sport
    const e1 = mdStr(md, 'service_1');
    if (e1) {
      if (!byEnrichment.has(e1)) byEnrichment.set(e1, { label: e1, count: 0, revenue: 0 });
      const be = byEnrichment.get(e1)!;
      be.count++;
      be.revenue += s1;
    }
    const e2 = mdStr(md, 'service_2');
    if (e2) {
      if (!bySport.has(e2)) bySport.set(e2, { label: e2, count: 0, revenue: 0 });
      const bs = bySport.get(e2)!;
      bs.count++;
      bs.revenue += s2;
    }

    const studentName =
      (r.preferred_name && r.preferred_name.trim()) || r.first_name;
    const parent = r.primary_parent_name ?? '';

    if (fa > 0) finAidList.push({
      name: `${studentName} ${r.last_name}`,
      sub: parent,
      amount: fa,
    });
    if (esaAmt > 0 || ynActive(mdStr(md, 'esa_recipient'))) {
      esaList.push({ name: `${studentName} ${r.last_name}`, sub: parent, amount: esaAmt });
    }
    if (stoAmt > 0 || ynActive(mdStr(md, 'sto_recipient')) || mdStr(md, 'sto_type')) {
      const ty = mdStr(md, 'sto_type');
      stoList.push({
        name: `${studentName} ${r.last_name}`,
        sub: `${parent}${ty ? ` · ${ty}` : ''}`,
        amount: stoAmt,
      });
    }
  }

  const totalRevenue = tuition + extDay + lunch + admin + enrollFee + svc1 + svc2 + sst + lateFee;
  const totalDiscounts = employeeDiscount + annualDiscount + siblingDiscount;
  const totalAids = financialAid + referralCredit + esa + stoOrig + stoSwitcher + stoCorp + stoOther;
  const net = totalRevenue - totalDiscounts - totalAids;

  // FACTS actuals for the current year — from the per-account ledger we
  // imported (all matched to students). This is the source of truth for
  // actual cash position (charged / collected / outstanding).
  const facts = await loadFactsActuals(school.schoolId, FINANCE_YEAR);

  // Live payments — aggregates from the platform's own invoices +
  // family_tuition_enrollments tables. Independent of FACTS; native
  // tenants (MCH and forward) populate this from day one.
  const livePayments = await loadLivePayments(school.schoolId);

  // Per-tab payloads — only fetch the active tab's heavier data set.
  const students = fin_tab === 'students'
    ? await loadStudentProgress(school.schoolId, FINANCE_YEAR, q, status, enrolledOnly) : null;
  const transactions = fin_tab === 'transactions'
    ? await loadTransactions(school.schoolId, FINANCE_YEAR, acct, q) : null;

  return {
    fin_tab, q, acct, status,
    enr: enrolledOnly ? 'enrolled' : 'all',
    students, transactions,
    account_options: ACCOUNT_OPTIONS,
    facts,
    live_payments: livePayments,
    total_revenue: totalRevenue,
    total_discounts: totalDiscounts,
    total_aid_credits: totalAids,
    net_revenue: net,
    student_count: rows.length,
    by_program: [...byProgram.values()],
    total_tuition: tuition,
    enrollment_fee: enrollFee,
    admin_fee: admin,
    extended_day: extDay,
    lunch,
    sst,
    enrichments_total: svc1,
    sports_total: svc2,
    late_fees: lateFee,
    employee_discount: employeeDiscount,
    annual_discount: annualDiscount,
    sibling_discount: siblingDiscount,
    financial_aid: financialAid,
    referral_credit: referralCredit,
    esa,
    sto_orig: stoOrig,
    sto_switcher: stoSwitcher,
    sto_corp: stoCorp,
    sto_other: stoOther,
    by_enrichment: [...byEnrichment.values()].sort((a, b) => b.revenue - a.revenue),
    by_sport: [...bySport.values()].sort((a, b) => b.revenue - a.revenue),
    fin_aid_recipients: finAidList.sort((a, b) => b.amount - a.amount),
    esa_recipients: esaList.sort((a, b) => b.amount - a.amount),
    sto_recipients: stoList.sort((a, b) => b.amount - a.amount),
  };
}

// FACTS accounts in display order — also powers the Transactions filter.
const ACCOUNT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'annual_tuition', label: 'Tuition' },
  { key: 'enrollment_fee', label: 'Enrollment Fee' },
  { key: 'administrative_fee', label: 'Administrative Fee' },
  { key: 'extended_day', label: 'Extended Day' },
  { key: 'organic_lunch', label: 'Lunch' },
  { key: 'chromebook_fee', label: 'Chromebook Fee' },
  { key: 'withdrawal_fee', label: 'Withdrawal Fee' },
];

// Actual cash position for the year from the FACTS per-account ledger
// (facts_account_ledger) — every charge / credit / payment, all matched
// to a student. Outstanding A/R = sum of remaining (ending) balances.
// Returns null if nothing has been imported for the year.
async function loadFactsActuals(schoolId: string, year: string): Promise<FactsActuals | null> {
  const { rows: agg } = await query<{
    rows: string; matched: string;
    charges: string | null; credits: string | null; payments: string | null; amt_due: string | null;
    paid_in_full: string; owes_under_500: string; owes_500_2000: string;
    owes_2000_5000: string; owes_over_5000: string;
  }>(
    `WITH stu AS (
       SELECT l.student_id,
              SUM(l.charges_cents) ch, SUM(l.credits_cents) cr,
              SUM(l.payments_cents + l.credits_applied_cents) pay, SUM(l.ending_balance_cents) bal
         FROM facts_account_ledger l
        WHERE l.school_id = $1 AND l.academic_year = $2
        GROUP BY l.student_id)
     SELECT count(*)::text AS rows,
            count(*) FILTER (WHERE student_id IS NOT NULL)::text AS matched,
            COALESCE(SUM(ch),0)::text AS charges,
            COALESCE(SUM(cr),0)::text AS credits,
            COALESCE(SUM(pay),0)::text AS payments,
            COALESCE(SUM(bal),0)::text AS amt_due,
            count(*) FILTER (WHERE bal <= 0)::text AS paid_in_full,
            count(*) FILTER (WHERE bal > 0 AND bal <= 50000)::text AS owes_under_500,
            count(*) FILTER (WHERE bal > 50000 AND bal <= 200000)::text AS owes_500_2000,
            count(*) FILTER (WHERE bal > 200000 AND bal <= 500000)::text AS owes_2000_5000,
            count(*) FILTER (WHERE bal > 500000)::text AS owes_over_5000
       FROM stu`,
    [schoolId, year],
  );
  const a = agg[0];
  if (!a || Number(a.rows) === 0) return null;

  const { rows: imp } = await query<{ imported_at: Date | null }>(
    `SELECT MAX(imported_at) AS imported_at FROM facts_account_ledger WHERE school_id = $1 AND academic_year = $2`,
    [schoolId, year],
  );

  const { rows: top } = await query<{
    first_name: string; last_name: string; preferred_name: string | null;
    family_id: string | null; family: string; ch: string; pay: string; bal: string;
  }>(
    `SELECT s.first_name, s.last_name, s.preferred_name, s.family_id,
            COALESCE(f.display_name,'') AS family,
            SUM(l.charges_cents)::text AS ch, SUM(l.payments_cents + l.credits_applied_cents)::text AS pay,
            SUM(l.ending_balance_cents)::text AS bal
       FROM facts_account_ledger l
       JOIN students s ON s.id = l.student_id
       LEFT JOIN families f ON f.id = s.family_id
      WHERE l.school_id = $1 AND l.academic_year = $2
      GROUP BY s.id, s.first_name, s.last_name, s.preferred_name, s.family_id, f.display_name
     HAVING SUM(l.ending_balance_cents) > 0
      ORDER BY SUM(l.ending_balance_cents) DESC
      LIMIT 25`,
    [schoolId, year],
  );

  const c = (s: string | null) => Number(s ?? 0) / 100;
  return {
    term: year === '2026-27' ? '2026-2027' : year,
    has_data: true,
    rows: Number(a.rows),
    matched_to_students: Number(a.matched),
    charges: c(a.charges),
    credits: c(a.credits),
    payments: c(a.payments),
    amount_due: c(a.amt_due),
    credit_balance: 0,
    delinquent_balance: 0,
    ar_buckets: {
      paid_in_full: Number(a.paid_in_full),
      owes_under_500: Number(a.owes_under_500),
      owes_500_2000: Number(a.owes_500_2000),
      owes_2000_5000: Number(a.owes_2000_5000),
      owes_over_5000: Number(a.owes_over_5000),
      delinquent_count: 0,
    },
    top_delinquent: top.map((r) => ({
      customer_name: r.family || `${r.first_name} ${r.last_name}`,
      student_name: `${(r.preferred_name && r.preferred_name.trim()) || r.first_name} ${r.last_name}`,
      charges: c(r.ch), payments: c(r.pay), amount_due: c(r.bal),
      delinquent_balance: 0, matched_family_id: r.family_id,
    })),
    imported_at: imp[0]?.imported_at ? imp[0].imported_at.toISOString() : null,
  };
}

// "Students & Families" tab — per active student: FACTS charged / paid /
// remaining + their Growth Suite plan + go-forward schedule. Optional
// name search (q) and balance filter (status).
async function loadStudentProgress(
  schoolId: string, year: string, q: string, status: string, enrolledOnly: boolean,
): Promise<StudentProgressRow[]> {
  const like = q ? `%${q}%` : null;
  const { rows } = await query<{
    id: string; first_name: string; last_name: string; preferred_name: string | null;
    unique_id: string | null;
    family_id: string | null; family: string; program: string; plan: string;
    gs_first_due: string | null; charged: string; credits: string; paid: string;
    balance: string; gs_installments: string; gs_scheduled: string;
    md_charged: string | null; md_credits: string | null; md_paid: string | null;
    md_balance: string | null;
  }>(
    `SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.family_id,
            s.metadata->>'unique_id' AS unique_id,
            COALESCE(f.display_name,'') AS family,
            COALESCE(s.metadata->>'program_name','') AS program,
            COALESCE((SELECT pp.display_name FROM family_tuition_enrollments e
                        LEFT JOIN payment_plans pp ON pp.id = e.payment_plan_id
                       WHERE e.student_id = s.id AND e.academic_year = $2 AND e.payment_plan_id IS NOT NULL
                       LIMIT 1), '') AS plan,
            (SELECT to_char(MIN(e.first_due_date),'YYYY-MM-DD') FROM family_tuition_enrollments e
              WHERE e.student_id = s.id AND e.academic_year = $2) AS gs_first_due,
            COALESCE((SELECT SUM(l.charges_cents) FROM facts_account_ledger l WHERE l.student_id = s.id AND l.academic_year = $2),0)::text AS charged,
            COALESCE((SELECT SUM(l.credits_cents) FROM facts_account_ledger l WHERE l.student_id = s.id AND l.academic_year = $2),0)::text AS credits,
            COALESCE((SELECT SUM(l.payments_cents + l.credits_applied_cents) FROM facts_account_ledger l WHERE l.student_id = s.id AND l.academic_year = $2),0)::text AS paid,
            COALESCE((SELECT SUM(l.ending_balance_cents) FROM facts_account_ledger l WHERE l.student_id = s.id AND l.academic_year = $2),0)::text AS balance,
            -- Contact-record figures (the school's sheet → GHL custom fields,
            -- mirrored into metadata). These WIN when present; FACTS above is
            -- only a fallback for legacy tenants that imported a FACTS ledger.
            s.metadata->>'total_charges'     AS md_charged,
            s.metadata->>'total_credits'     AS md_credits,
            s.metadata->>'payments'          AS md_paid,
            s.metadata->>'remaining_balance' AS md_balance,
            COALESCE((SELECT COUNT(*) FROM invoices i WHERE i.student_id = s.id AND i.source = 'tuition_plan' AND i.voided_at IS NULL),0)::text AS gs_installments,
            COALESCE((SELECT SUM(li.amount_cents) FROM invoices i JOIN invoice_line_items li ON li.invoice_id = i.id
                       WHERE i.student_id = s.id AND i.source = 'tuition_plan' AND i.voided_at IS NULL),0)::text AS gs_scheduled
       FROM students s
       JOIN families f ON f.id = s.family_id
      WHERE s.school_id = $1 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
        AND ($4::boolean IS NOT TRUE OR EXISTS (
              SELECT 1 FROM enrollments e
               WHERE e.student_id = s.id AND e.academic_year = $2 AND e.status = 'enrolled'))
        AND ($3::text IS NULL OR s.first_name ILIKE $3 OR s.last_name ILIKE $3 OR f.display_name ILIKE $3)
      ORDER BY s.last_name, s.first_name
      LIMIT 1000`,
    [schoolId, year, like, enrolledOnly],
  );
  const c = (v: string) => Number(v ?? 0) / 100;          // FACTS cents → dollars
  const md = (v: string | null) => (v == null || v === '' ? null : Number(v)); // contact-record dollars
  let out: StudentProgressRow[] = rows.map((r) => {
    // Contact-record numbers (Total Charges / Total Credits / Payments /
    // Remaining Balance from the GHL contact) take precedence. FACTS is only
    // a fallback for legacy tenants that imported a ledger — DGM 2.0 has none.
    const mdCharged = md(r.md_charged);
    let charged: number, credits: number, paid: number, balance: number;
    if (mdCharged != null) {
      charged = mdCharged;
      credits = md(r.md_credits) ?? 0;
      paid = md(r.md_paid) ?? 0;
      const mdBal = md(r.md_balance);
      balance = mdBal != null ? mdBal : Math.max(0, charged - credits - paid);
    } else {
      charged = c(r.charged); credits = c(r.credits); paid = c(r.paid); balance = c(r.balance);
    }
    const net = Math.max(0, charged - credits);
    const pct = net > 0 ? Math.min(100, Math.round((paid / net) * 100)) : (paid > 0 ? 100 : 0);
    return {
      student_id: r.id,
      unique_id: r.unique_id,
      student_name: `${(r.preferred_name && r.preferred_name.trim()) || r.first_name} ${r.last_name}`.trim(),
      family: r.family, family_id: r.family_id, program: r.program, plan: r.plan,
      charged, credits, paid, balance, pct_paid: pct,
      gs_installments: Number(r.gs_installments), gs_scheduled: c(r.gs_scheduled), gs_first_due: r.gs_first_due,
      accounts: [], schedule: [],
    };
  });
  if (status === 'balance') out = out.filter((r) => r.balance > 0.005);
  else if (status === 'paid') out = out.filter((r) => r.balance <= 0.005 && r.charged > 0);
  else if (status === 'no_facts') out = out.filter((r) => r.charged === 0);

  // Attach per-student drill-down detail (FACTS account history + the
  // Growth Suite payment schedule) for the rows we're returning.
  const ids = out.map((r) => r.student_id);
  if (ids.length > 0) {
    const byId = new Map(out.map((r) => [r.student_id, r]));
    const { rows: acctRows } = await query<{
      student_id: string; account: string;
      charges_cents: string; credits_cents: string; payments_cents: string; ending_balance_cents: string;
    }>(
      `SELECT student_id, account,
              charges_cents::text, credits_cents::text, payments_cents::text, ending_balance_cents::text
         FROM facts_account_ledger
        WHERE school_id = $1 AND academic_year = $2 AND student_id = ANY($3::uuid[])
        ORDER BY account`,
      [schoolId, year, ids],
    );
    for (const r of acctRows) {
      byId.get(r.student_id)?.accounts.push({
        account: r.account, charged: c(r.charges_cents), credit: c(r.credits_cents),
        paid: c(r.payments_cents), balance: c(r.ending_balance_cents),
      });
    }
    // Consolidated schedule: tuition installments AND incidental one-off fees
    // (enrollment fee, late fees, etc.) on one timeline, each with its due
    // date — so the office sees every upcoming draw in one place.
    const { rows: invRows } = await query<{
      student_id: string; invoice_number: string; title: string | null; source: string | null; due_at: Date | null;
      total_cents: string; amount_paid_cents: string; status: string;
    }>(
      `SELECT student_id, invoice_number, title, source, due_at, total_cents::text, amount_paid_cents::text, status
         FROM invoices
        WHERE school_id = $1 AND voided_at IS NULL
          AND student_id = ANY($2::uuid[])
        ORDER BY due_at NULLS LAST, invoice_number`,
      [schoolId, ids],
    );
    for (const r of invRows) {
      const total = c(r.total_cents), paid = c(r.amount_paid_cents);
      const st = r.status === 'paid' || (total > 0 && paid >= total) ? 'Paid'
        : paid > 0 ? 'Partial'
        : r.status === 'draft' ? 'Scheduled (draft)'
        : 'Scheduled';
      const isTuition = r.source === 'tuition_plan';
      byId.get(r.student_id)?.schedule.push({
        label: isTuition ? r.invoice_number : (r.title || r.invoice_number),
        due: r.due_at ? r.due_at.toISOString().slice(0, 10) : null,
        amount: total, status: st, paid,
        kind: isTuition ? 'tuition' : 'fee',
      });
    }
  }
  return out;
}

// "Transactions" tab — every FACTS ledger line, filterable by account and
// student name.
async function loadTransactions(
  schoolId: string, year: string, acct: string, q: string,
): Promise<TransactionRow[]> {
  const like = q ? `%${q}%` : null;
  const acctKey = ACCOUNT_OPTIONS.some((o) => o.key === acct) ? acct : null;
  const { rows } = await query<{
    student_name: string | null; account: string; account_key: string;
    charges_cents: string; credits_cents: string; payments_cents: string; ending_balance_cents: string;
    family_id: string | null; family: string;
  }>(
    `SELECT l.student_name, l.account, l.account_key,
            l.charges_cents::text, l.credits_cents::text, l.payments_cents::text, l.ending_balance_cents::text,
            s.family_id, COALESCE(f.display_name,'') AS family
       FROM facts_account_ledger l
       LEFT JOIN students s ON s.id = l.student_id
       LEFT JOIN families f ON f.id = s.family_id
      WHERE l.school_id = $1 AND l.academic_year = $2
        AND ($3::text IS NULL OR l.account_key = $3)
        AND ($4::text IS NULL OR l.student_name ILIKE $4)
      ORDER BY l.student_name, l.account
      LIMIT 1000`,
    [schoolId, year, acctKey, like],
  );
  const c = (v: string) => Number(v ?? 0) / 100;
  return rows.map((r) => ({
    student_name: r.student_name ?? '', family: r.family, family_id: r.family_id,
    account: r.account, account_key: r.account_key,
    charged: c(r.charges_cents), credit: c(r.credits_cents), paid: c(r.payments_cents), balance: c(r.ending_balance_cents),
  }));
}

// Native (non-FACTS) cash + contracted figures. Aggregates from the
// invoices and family_tuition_enrollments tables — the source of truth
// for tenants on the new tuition stack.
//
// Returns null only when the school has *zero* invoices AND zero active
// enrollments (a brand-new tenant whose tuition system isn't wired yet).
async function loadLivePayments(schoolId: string): Promise<LivePayments | null> {
  // Invoice aggregates: how much we've billed, paid, and have outstanding.
  const { rows: invAgg } = await query<{
    total_invoices: string;
    open_invoices: string;
    paid_invoices: string;
    partially_paid_invoices: string;
    voided_invoices: string;
    total_billed_cents: string | null;
    total_paid_cents: string | null;
  }>(
    `SELECT COUNT(*)::text AS total_invoices,
            COUNT(*) FILTER (WHERE status = 'open')::text AS open_invoices,
            COUNT(*) FILTER (WHERE status = 'paid')::text AS paid_invoices,
            COUNT(*) FILTER (WHERE status = 'partially_paid')::text AS partially_paid_invoices,
            COUNT(*) FILTER (WHERE status = 'voided')::text AS voided_invoices,
            COALESCE(SUM(total_cents) FILTER (WHERE status <> 'voided'), 0)::text AS total_billed_cents,
            COALESCE(SUM(amount_paid_cents), 0)::text AS total_paid_cents
       FROM invoices
      WHERE school_id = $1`,
    [schoolId],
  );

  // Enrollment aggregates: contracted annual revenue (the "what the
  // school is owed for the year" figure). Independent of invoice
  // generation timing — useful when invoices haven't been materialized
  // for all installments yet.
  const { rows: enrAgg } = await query<{
    active_enrollments: string;
    total_annual_contracted_cents: string | null;
  }>(
    `SELECT COUNT(*)::text AS active_enrollments,
            COALESCE(SUM(total_annual_cents), 0)::text AS total_annual_contracted_cents
       FROM family_tuition_enrollments fte
      WHERE fte.school_id = $1 AND fte.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM students s
                         WHERE s.id = fte.student_id AND (s.metadata->>'is_demo') = 'true')`,
    [schoolId],
  );

  const inv = invAgg[0];
  const enr = enrAgg[0];

  const totalInvoices = Number(inv?.total_invoices ?? 0);
  const activeEnrollments = Number(enr?.active_enrollments ?? 0);
  if (totalInvoices === 0 && activeEnrollments === 0) return null;

  const totalBilled = Number(inv?.total_billed_cents ?? 0);
  const totalPaid = Number(inv?.total_paid_cents ?? 0);
  return {
    has_data: true,
    total_invoices: totalInvoices,
    open_invoices: Number(inv?.open_invoices ?? 0),
    paid_invoices: Number(inv?.paid_invoices ?? 0),
    partially_paid_invoices: Number(inv?.partially_paid_invoices ?? 0),
    voided_invoices: Number(inv?.voided_invoices ?? 0),
    total_billed_cents: totalBilled,
    total_paid_cents: totalPaid,
    total_outstanding_cents: Math.max(0, totalBilled - totalPaid),
    active_enrollments: activeEnrollments,
    total_annual_contracted_cents: Number(enr?.total_annual_contracted_cents ?? 0),
  };
}
