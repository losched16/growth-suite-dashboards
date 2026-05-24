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

export interface FinanceData {
  // Top-line cards
  total_revenue: number;
  total_discounts: number;
  total_aid_credits: number;
  net_revenue: number;
  student_count: number;
  // Actual cash data from FACTS (null if no import yet)
  facts: FactsActuals | null;

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

export async function fetcher(
  school: SchoolContext,
  config: FinanceDashboardConfig,
  _searchParams?: WidgetSearchParams,
): Promise<FinanceData> {
  const groups = config.program_groups ?? [];

  const { rows } = await query<DbStudent>(
    `SELECT
       s.metadata, s.first_name, s.last_name, s.preferred_name,
       (SELECT first_name || ' ' || last_name FROM parents pp
        WHERE pp.family_id = s.family_id AND pp.is_primary = true LIMIT 1) AS primary_parent_name
     FROM students s
     WHERE s.school_id = $1 AND s.status = 'active'`,
    [school.schoolId],
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
    if (!m) continue;

    const t = mdNum(m, 'tuition_fee');
    const e = mdNum(m, 'extended_day_fee');
    const lu = mdNum(m, 'lunch_fee');
    const a = mdNum(m, 'admin_fee');
    const ef = mdNum(m, 'enrollment_fee');
    const s1 = mdNum(m, 'service_1_bill_amount');
    const s2 = mdNum(m, 'service_2_bill_amount');
    const sstF = mdNum(m, 'sst_fee');
    const lf = mdNum(m, 'late_fee');
    const ed = mdNum(m, 'employee_discount');
    const ad = mdNum(m, 'annual_discount');
    const sd = mdNum(m, 'sibling_discount');
    const fa = mdNum(m, 'financial_aid');
    const rc = mdNum(m, 'referral_credit');
    const esaAmt = mdNum(m, 'esa_amount');
    const stoAmt = mdNum(m, 'sto_amount');

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

    const stoType = mdStr(m, 'sto_type').toLowerCase();
    if (stoAmt > 0) {
      if (stoType.includes('orig')) stoOrig += stoAmt;
      else if (stoType.includes('switch')) stoSwitcher += stoAmt;
      else if (stoType.includes('corp')) stoCorp += stoAmt;
      else stoOther += stoAmt;
    }

    // By-program
    const program = mdStr(m, 'program');
    const groupLabel = pickProgramGroup(program, groups);
    if (!byProgram.has(groupLabel)) byProgram.set(groupLabel, { label: groupLabel, count: 0, tuition: 0 });
    const bp = byProgram.get(groupLabel)!;
    bp.count++;
    bp.tuition += t;

    // By enrichment / sport
    const e1 = mdStr(m, 'service_1');
    if (e1) {
      if (!byEnrichment.has(e1)) byEnrichment.set(e1, { label: e1, count: 0, revenue: 0 });
      const be = byEnrichment.get(e1)!;
      be.count++;
      be.revenue += s1;
    }
    const e2 = mdStr(m, 'service_2');
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
    if (esaAmt > 0 || ynActive(mdStr(m, 'esa_recipient'))) {
      esaList.push({ name: `${studentName} ${r.last_name}`, sub: parent, amount: esaAmt });
    }
    if (stoAmt > 0 || ynActive(mdStr(m, 'sto_recipient')) || mdStr(m, 'sto_type')) {
      const ty = mdStr(m, 'sto_type');
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

  // FACTS actuals — picks the most-recently-imported term automatically.
  const facts = await loadFactsActuals(school.schoolId);

  return {
    facts,
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

// Load actual financial figures imported from FACTS Management. Picks
// the most-recently-imported term automatically (so re-importing newer
// terms surfaces them without code changes). Returns null if no FACTS
// data has been imported for this school.
async function loadFactsActuals(schoolId: string): Promise<FactsActuals | null> {
  const { rows: termRows } = await query<{ term: string }>(
    `SELECT term FROM facts_balances
     WHERE school_id = $1
     GROUP BY term
     ORDER BY MAX(imported_at) DESC
     LIMIT 1`,
    [schoolId],
  );
  if (termRows.length === 0) return null;
  const term = termRows[0].term;

  const { rows: aggRows } = await query<{
    rows: string;
    matched: string;
    charges: string | null;
    credits: string | null;
    payments: string | null;
    amt_due: string | null;
    credit_bal: string | null;
    delinquent: string | null;
    imported_at: Date | null;
    paid_in_full: string;
    owes_under_500: string;
    owes_500_2000: string;
    owes_2000_5000: string;
    owes_over_5000: string;
    delinquent_count: string;
  }>(
    `SELECT
       count(*)::text AS rows,
       count(*) FILTER (WHERE matched_student_id IS NOT NULL)::text AS matched,
       sum(charges)::text AS charges,
       sum(credits)::text AS credits,
       sum(payments)::text AS payments,
       sum(remaining_amount_due)::text AS amt_due,
       sum(remaining_credit_balance)::text AS credit_bal,
       sum(delinquent_balance)::text AS delinquent,
       MAX(imported_at) AS imported_at,
       count(*) FILTER (WHERE remaining_amount_due = 0)::text AS paid_in_full,
       count(*) FILTER (WHERE remaining_amount_due > 0 AND remaining_amount_due <= 500)::text AS owes_under_500,
       count(*) FILTER (WHERE remaining_amount_due > 500 AND remaining_amount_due <= 2000)::text AS owes_500_2000,
       count(*) FILTER (WHERE remaining_amount_due > 2000 AND remaining_amount_due <= 5000)::text AS owes_2000_5000,
       count(*) FILTER (WHERE remaining_amount_due > 5000)::text AS owes_over_5000,
       count(*) FILTER (WHERE delinquent_balance > 0)::text AS delinquent_count
     FROM facts_balances
     WHERE school_id = $1 AND term = $2`,
    [schoolId, term],
  );
  const a = aggRows[0];

  const { rows: topRows } = await query<{
    customer_name: string;
    facts_student_name: string;
    charges: string;
    payments: string;
    remaining_amount_due: string;
    delinquent_balance: string;
    matched_family_id: string | null;
  }>(
    `SELECT customer_name, facts_student_name, charges, payments,
            remaining_amount_due, delinquent_balance, matched_family_id
     FROM facts_balances
     WHERE school_id = $1 AND term = $2 AND remaining_amount_due > 0
     ORDER BY remaining_amount_due DESC
     LIMIT 25`,
    [schoolId, term],
  );

  return {
    term,
    has_data: true,
    rows: Number(a.rows),
    matched_to_students: Number(a.matched),
    charges: Number(a.charges ?? 0),
    credits: Number(a.credits ?? 0),
    payments: Number(a.payments ?? 0),
    amount_due: Number(a.amt_due ?? 0),
    credit_balance: Number(a.credit_bal ?? 0),
    delinquent_balance: Number(a.delinquent ?? 0),
    ar_buckets: {
      paid_in_full: Number(a.paid_in_full),
      owes_under_500: Number(a.owes_under_500),
      owes_500_2000: Number(a.owes_500_2000),
      owes_2000_5000: Number(a.owes_2000_5000),
      owes_over_5000: Number(a.owes_over_5000),
      delinquent_count: Number(a.delinquent_count),
    },
    top_delinquent: topRows.map((r) => ({
      customer_name: r.customer_name,
      student_name: r.facts_student_name,
      charges: Number(r.charges),
      payments: Number(r.payments),
      amount_due: Number(r.remaining_amount_due),
      delinquent_balance: Number(r.delinquent_balance),
      matched_family_id: r.matched_family_id,
    })),
    imported_at: a.imported_at ? a.imported_at.toISOString() : null,
  };
}
