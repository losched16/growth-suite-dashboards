// CSV export — FACTS per-account ledger (2026-27). One row per student per
// FACTS account (Tuition, Enrollment Fee, Administrative Fee, Extended Day,
// Lunch, Chromebook Fee, Withdrawal Fee, ...) with beginning balance,
// charges, credits, payments and ending balance — the line-level detail
// behind the roster's Payments / Credits Applied columns. Lets the office
// tie every debit/credit to the exact account it landed on, against FACTS.
//
// GET /api/export/facts-ledger/{locationId}?year=2026-27

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExportPublic, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';

type Params = Promise<{ locationId: string }>;

interface LedgerRow {
  student_name: string | null;
  facts_student_id: string;
  gs_student: string | null;
  account: string;
  beginning_balance_cents: number;
  charges_cents: number;
  credits_cents: number;
  payments_cents: number;
  credits_applied_cents: number;
  ending_balance_cents: number;
}

const dollars = (cents: number | null | undefined): string =>
  cents == null || cents === 0 ? '' : (cents / 100).toFixed(2);

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExportPublic(request, locationId);
  if (!school) return unauthorizedCsvResponse();
  const year = (request.nextUrl.searchParams.get('year') ?? '2026-27').trim();

  const { rows } = await query<LedgerRow>(
    `SELECT l.student_name, l.facts_student_id, l.account,
            CASE WHEN s.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name)
                 ELSE NULL END AS gs_student,
            l.beginning_balance_cents, l.charges_cents, l.credits_cents,
            l.payments_cents, l.credits_applied_cents, l.ending_balance_cents
       FROM facts_account_ledger l
       LEFT JOIN students s ON s.id = l.student_id
      WHERE l.school_id = $1 AND l.academic_year = $2
      ORDER BY l.student_name, l.account`,
    [school.id, year],
  );

  const cols: CsvColumn<LedgerRow>[] = [
    { key: 'student_name', label: 'Student (FACTS)', value: (r) => r.student_name ?? '' },
    { key: 'facts_student_id', label: 'Student ID', value: (r) => r.facts_student_id },
    { key: 'gs_student', label: 'Matched in Growth Suite', value: (r) => r.gs_student ?? '(unmatched)' },
    { key: 'account', label: 'Account', value: (r) => r.account },
    { key: 'beginning', label: 'Beginning Balance', value: (r) => dollars(r.beginning_balance_cents) },
    { key: 'charges', label: 'Charges', value: (r) => dollars(r.charges_cents) },
    { key: 'credits', label: 'Credits', value: (r) => dollars(r.credits_cents) },
    { key: 'payments', label: 'Payments', value: (r) => dollars(r.payments_cents) },
    { key: 'credits_applied', label: 'Credits Applied', value: (r) => dollars(r.credits_applied_cents) },
    { key: 'ending', label: 'Ending Balance', value: (r) => dollars(r.ending_balance_cents) },
  ];

  return csvResponse(`facts-account-ledger-${year}-${dateStamp()}.csv`, toCsv(rows, cols));
}
