// CSV export — FACTS transactions (2026-27). One row per imported FACTS
// ledger, columns laid out in the SAME order as the FACTS spreadsheet so
// the office can diff it against their original file line-for-line.
//
// GET /api/export/facts/{locationId}?year=2026-27

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExportPublic, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';

type Params = Promise<{ locationId: string }>;

interface FactsRow {
  unique_id: string;
  parent_name: string | null;
  student_name: string | null;
  gs_student: string | null;       // matched Growth Suite student (or null)
  charges: Record<string, number> | null;
  credits: Record<string, number> | null;
  total_charges_cents: number;
  total_credits_cents: number;
  net_charges_cents: number;
  payments_cents: number;
  credits_applied_cents: number;
  remaining_balance_cents: number;
}

// Charge + credit categories in FACTS-spreadsheet order.
const CHARGES: Array<[string, string]> = [
  ['annual_tuition', 'Annual Tuition'], ['administrative_fee', 'Administrative Fee'],
  ['late_fee', 'Late Fee'], ['organic_lunch', 'Organic Lunch'], ['extended_day', 'Extended Day'],
  ['late_pickup_fee', 'Late Pickup Fee'], ['not_signed_out_fee', 'Not Signed Out Fee'],
  ['enrollment_fee', 'Enrollment Fee'], ['enrichment', 'Enrichment'], ['athletics', 'Athletics'],
  ['withdrawal_fee', 'Withdrawal Fee'], ['sst_tuition', 'SST Tuition'], ['change_fee', 'Change Fee'],
  ['chromebook_fee', 'Chromebook Fee'], ['childcare', 'Childcare'], ['hearing_vision', 'Hearing & Vision'],
];
const CREDITS: Array<[string, string]> = [
  ['annual_discount', 'Annual Discount'], ['sibling_discount', 'Sibling Discount'],
  ['employee_discount', 'Employee Discount'], ['financial_aid', 'Financial Aid'],
  ['miscellaneous', 'Miscellaneous'],
];

const dollars = (cents: number | null | undefined): string =>
  cents == null || cents === 0 ? '' : (cents / 100).toFixed(2);

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExportPublic(request, locationId);
  if (!school) return unauthorizedCsvResponse();
  const year = (request.nextUrl.searchParams.get('year') ?? '2026-27').trim();

  const { rows } = await query<FactsRow>(
    `SELECT ft.unique_id, ft.parent_name, ft.student_name,
            CASE WHEN s.id IS NOT NULL
                 THEN CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name)
                 ELSE NULL END AS gs_student,
            ft.charges, ft.credits,
            ft.total_charges_cents, ft.total_credits_cents, ft.net_charges_cents,
            ft.payments_cents, ft.credits_applied_cents, ft.remaining_balance_cents
       FROM facts_transactions ft
       LEFT JOIN students s ON s.id = ft.student_id
      WHERE ft.school_id = $1 AND ft.academic_year = $2
      ORDER BY ft.parent_name, ft.student_name`,
    [school.id, year],
  );

  const cols: CsvColumn<FactsRow>[] = [
    { key: 'parent_name',  label: 'Parent Name',  value: (r) => r.parent_name ?? '' },
    { key: 'student_name', label: 'Student Name (FACTS)', value: (r) => r.student_name ?? '' },
    { key: 'student_id',   label: 'Student ID',   value: (r) => r.unique_id },
    { key: 'gs_student',   label: 'Matched in Growth Suite', value: (r) => r.gs_student ?? '(unmatched)' },
    ...CHARGES.map(([k, label]): CsvColumn<FactsRow> => ({ key: `c_${k}`, label, value: (r) => dollars(r.charges?.[k]) })),
    { key: 'total_charges', label: 'Total Charges', value: (r) => dollars(r.total_charges_cents) },
    ...CREDITS.map(([k, label]): CsvColumn<FactsRow> => ({ key: `d_${k}`, label, value: (r) => dollars(r.credits?.[k]) })),
    { key: 'total_credits',  label: 'Total Credits',  value: (r) => dollars(r.total_credits_cents) },
    { key: 'net_charges',    label: 'Net Charges',    value: (r) => dollars(r.net_charges_cents) },
    { key: 'payments',       label: 'Payments',       value: (r) => dollars(r.payments_cents) },
    { key: 'credits_applied', label: 'Credits Applied', value: (r) => dollars(r.credits_applied_cents) },
    { key: 'remaining',      label: 'Remaining Balance', value: (r) => dollars(r.remaining_balance_cents) },
  ];

  return csvResponse(`facts-tuition-${year}-${dateStamp()}.csv`, toCsv(rows, cols));
}
