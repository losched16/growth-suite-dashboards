// CSV export — FinanceDashboard. Defaults to a per-student breakdown
// with all line items + discounts + aid. `?type=program` returns the
// per-program rollup; `?type=enrichment` returns enrichment breakdown;
// `?type=sport` returns sports breakdown; `?type=fin_aid` returns
// financial-aid recipients only.

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  notFoundCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher as financeFetcher } from '@/lib/widgets/components/FinanceDashboard/fetcher';
import { financeDashboardDefaults } from '@/lib/widgets/components/FinanceDashboard/config';

type Params = Promise<{ locationId: string }>;

interface StudentFinRow {
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  primary_parent_name: string | null;
  primary_parent_email: string | null;
  metadata: Record<string, unknown> | null;
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
  return (typeof v === 'string' ? v : String(v)).trim();
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const type = request.nextUrl.searchParams.get('type') ?? 'students';

  // Rollup types reuse the widget's fetcher
  if (type === 'program' || type === 'enrichment' || type === 'sport' || type === 'fin_aid' || type === 'esa' || type === 'sto') {
    const data = await financeFetcher(
      { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
      financeDashboardDefaults,
    );
    if (type === 'program') {
      return csvResponse(
        `${school.name}-tuition-by-program-${dateStamp()}.csv`,
        toCsv(data.by_program, [
          { key: 'label',   label: 'Program' },
          { key: 'count',   label: 'Students' },
          { key: 'tuition', label: 'Tuition revenue (contracted)' },
        ]),
      );
    }
    if (type === 'enrichment') {
      return csvResponse(
        `${school.name}-enrichment-revenue-${dateStamp()}.csv`,
        toCsv(data.by_enrichment, [
          { key: 'label',   label: 'Enrichment class' },
          { key: 'count',   label: 'Students' },
          { key: 'revenue', label: 'Revenue (contracted)' },
        ]),
      );
    }
    if (type === 'sport') {
      return csvResponse(
        `${school.name}-sports-revenue-${dateStamp()}.csv`,
        toCsv(data.by_sport, [
          { key: 'label',   label: 'Sport' },
          { key: 'count',   label: 'Students' },
          { key: 'revenue', label: 'Revenue (contracted)' },
        ]),
      );
    }
    if (type === 'fin_aid') {
      return csvResponse(
        `${school.name}-financial-aid-recipients-${dateStamp()}.csv`,
        toCsv(data.fin_aid_recipients, [
          { key: 'name',   label: 'Student' },
          { key: 'sub',    label: 'Parent' },
          { key: 'amount', label: 'Financial aid award' },
        ]),
      );
    }
    if (type === 'esa') {
      return csvResponse(
        `${school.name}-esa-recipients-${dateStamp()}.csv`,
        toCsv(data.esa_recipients, [
          { key: 'name',   label: 'Student' },
          { key: 'sub',    label: 'Parent' },
          { key: 'amount', label: 'ESA amount' },
        ]),
      );
    }
    if (type === 'sto') {
      return csvResponse(
        `${school.name}-sto-recipients-${dateStamp()}.csv`,
        toCsv(data.sto_recipients, [
          { key: 'name',   label: 'Student' },
          { key: 'sub',    label: 'Parent · STO type' },
          { key: 'amount', label: 'STO amount' },
        ]),
      );
    }
  }

  // Default: per-student full financial breakdown
  const { rows } = await query<StudentFinRow>(
    `SELECT
       s.first_name, s.last_name, s.preferred_name, s.metadata,
       (SELECT first_name || ' ' || last_name FROM parents pp
        WHERE pp.family_id = s.family_id AND pp.is_primary = true LIMIT 1) AS primary_parent_name,
       (SELECT email FROM parents pp
        WHERE pp.family_id = s.family_id AND pp.is_primary = true LIMIT 1) AS primary_parent_email
     FROM students s
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.last_name, s.first_name`,
    [school.id],
  );

  const cols: CsvColumn<StudentFinRow>[] = [
    { key: 'student',   label: 'Student',           value: (r) => `${r.preferred_name || r.first_name} ${r.last_name}` },
    { key: 'parent',    label: 'Primary parent',    value: (r) => r.primary_parent_name ?? '' },
    { key: 'email',     label: 'Email',             value: (r) => r.primary_parent_email ?? '' },
    { key: 'program',   label: 'Program',           value: (r) => mdStr(r.metadata, 'program') },
    { key: 'homeroom',  label: 'Homeroom',          value: (r) => mdStr(r.metadata, 'homeroom') },
    { key: 'plan',      label: 'Payment plan',      value: (r) => mdStr(r.metadata, 'payment_plan') },
    { key: 'tuition',   label: 'Tuition fee',       value: (r) => mdNum(r.metadata, 'tuition_fee') },
    { key: 'ext',       label: 'Extended day fee',  value: (r) => mdNum(r.metadata, 'extended_day_fee') },
    { key: 'lunch',     label: 'Lunch fee',         value: (r) => mdNum(r.metadata, 'lunch_fee') },
    { key: 'admin',     label: 'Admin fee',         value: (r) => mdNum(r.metadata, 'admin_fee') },
    { key: 'enroll',    label: 'Enrollment fee',    value: (r) => mdNum(r.metadata, 'enrollment_fee') },
    { key: 'svc1',      label: 'Service 1 (Enrichment)',     value: (r) => mdStr(r.metadata, 'service_1') },
    { key: 'svc1_bill', label: 'Service 1 bill',    value: (r) => mdNum(r.metadata, 'service_1_bill_amount') },
    { key: 'svc2',      label: 'Service 2 (Sport)', value: (r) => mdStr(r.metadata, 'service_2') },
    { key: 'svc2_bill', label: 'Service 2 bill',    value: (r) => mdNum(r.metadata, 'service_2_bill_amount') },
    { key: 'sst',       label: 'SST fee',           value: (r) => mdNum(r.metadata, 'sst_fee') },
    { key: 'late',      label: 'Late fee',          value: (r) => mdNum(r.metadata, 'late_fee') },
    { key: 'emp_disc',  label: 'Employee discount', value: (r) => mdNum(r.metadata, 'employee_discount') },
    { key: 'ann_disc',  label: 'Annual discount',   value: (r) => mdNum(r.metadata, 'annual_discount') },
    { key: 'sib_disc',  label: 'Sibling discount',  value: (r) => mdNum(r.metadata, 'sibling_discount') },
    { key: 'fin_aid',   label: 'Financial aid',     value: (r) => mdNum(r.metadata, 'financial_aid') },
    { key: 'ref_cred',  label: 'Referral credit',   value: (r) => mdNum(r.metadata, 'referral_credit') },
    { key: 'esa',       label: 'ESA amount',        value: (r) => mdNum(r.metadata, 'esa_amount') },
    { key: 'sto',       label: 'STO amount',        value: (r) => mdNum(r.metadata, 'sto_amount') },
    { key: 'sto_type',  label: 'STO type',          value: (r) => mdStr(r.metadata, 'sto_type') },
    { key: 'total',     label: 'Total amount',      value: (r) => mdNum(r.metadata, 'total_amount') },
  ];

  if (rows.length === 0) return notFoundCsvResponse();

  return csvResponse(
    `${school.name}-finance-by-student-${dateStamp()}.csv`,
    toCsv(rows, cols),
  );
}
