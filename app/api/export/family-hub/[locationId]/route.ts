// CSV export — FamilyHubTable.
//
// Scope: CURRENT data only — currently-enrolled students. The export used
// to run with the default config (no enrolled/year scope), so it pulled
// every active student, including pending applicants and prior-year rows
// that aren't on the live roster. We force only_enrolled so it matches the
// real enrolled population.
//
// Shape: ONE ROW PER STUDENT, with the family detail repeated on each row —
// so every child's info (DOB, grade, classroom, allergies, plan) is broken
// out in full rather than collapsed into one comma-joined "Students" cell.
//
// Honors the same search/status/program/plan/homeroom/allergy URL filters
// as the widget.

import type { NextRequest } from 'next/server';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import {
  fetcher as familyFetcher,
  type FamilyRow,
  type StudentRecord,
} from '@/lib/widgets/components/FamilyHubTable/fetcher';
import { familyHubDefaults } from '@/lib/widgets/components/FamilyHubTable/config';
import type { WidgetSearchParams } from '@/lib/widgets/types';

type Params = Promise<{ locationId: string }>;
type Row = { f: FamilyRow; s: StudentRecord | null };

function meta(s: StudentRecord | null, key: string): string {
  const v = s?.metadata?.[key];
  return v == null ? '' : String(v);
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const sp: WidgetSearchParams = {};
  for (const [k, v] of request.nextUrl.searchParams.entries()) {
    if (k === 'embed_token') continue;
    if (v) sp[k] = v;
  }

  const data = await familyFetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    { ...familyHubDefaults, only_enrolled: true },
    sp,
  );

  // Explode each family into one row per (enrolled) student. A family with
  // no students still emits a single row so it's never silently dropped.
  const rows: Row[] = data.filtered.flatMap((f): Row[] =>
    f.students && f.students.length > 0
      ? f.students.map((s): Row => ({ f, s }))
      : [{ f, s: null } as Row],
  );

  const cols: CsvColumn<Row>[] = [
    { key: 'family',        label: 'Family',               value: ({ f }) => f.family_display_name ?? `${f.primary_parent_name} Family` },
    { key: 'primary',       label: 'Primary parent',       value: ({ f }) => f.primary_parent_name },
    { key: 'primary_email', label: 'Primary email',        value: ({ f }) => f.primary_parent_email ?? '' },
    { key: 'primary_phone', label: 'Primary phone',        value: ({ f }) => f.primary_parent_phone ?? '' },
    { key: 'all_parents',   label: 'All parents',          value: ({ f }) => f.parents.map((p) => `${p.first_name} ${p.last_name}`.trim()).filter(Boolean).join('; ') },
    { key: 'parent_emails', label: 'All parent emails',    value: ({ f }) => f.parents.map((p) => p.email).filter(Boolean).join('; ') },
    { key: 'parent_phones', label: 'All parent phones',    value: ({ f }) => f.parents.map((p) => p.phone).filter(Boolean).join('; ') },
    { key: 's_first',       label: 'Student first name',   value: ({ s }) => s?.first_name ?? '' },
    { key: 's_last',        label: 'Student last name',    value: ({ s }) => s?.last_name ?? '' },
    { key: 's_pref',        label: 'Preferred name',       value: ({ s }) => s?.preferred_name ?? '' },
    { key: 's_dob',         label: 'Date of birth',        value: ({ s }) => s?.date_of_birth ?? '' },
    { key: 's_gender',      label: 'Gender',               value: ({ s }) => s?.gender ?? '' },
    { key: 's_grade',       label: 'Grade',                value: ({ s }) => s?.grade_level ?? '' },
    { key: 's_program',     label: 'Program',              value: ({ s }) => meta(s, 'program') },
    { key: 's_classroom',   label: 'Classroom',            value: ({ s }) => s?.classroom_name ?? '' },
    { key: 's_status',      label: 'Enrollment',           value: ({ s }) => (s?.enrollment_status ?? '').replace(/_/g, ' ') },
    { key: 's_schedule',    label: 'Schedule',             value: ({ s }) => s?.schedule ?? '' },
    { key: 's_start',       label: 'Start date',           value: ({ s }) => s?.enrolled_at ?? '' },
    { key: 's_allergy',     label: 'Has allergy',          value: ({ s }) => (s?.has_allergy ? 'yes' : 'no') },
    { key: 's_allergy_txt', label: 'Allergy detail',       value: ({ s }) => s?.allergy_text ?? '' },
    { key: 's_special',     label: 'Special instructions', value: ({ s }) => s?.special_instructions_text ?? '' },
    { key: 's_plan',        label: 'Payment plan',         value: ({ s }) => meta(s, 'payment_plan') },
    { key: 's_tuition',     label: 'Tuition',              value: ({ s }) => meta(s, 'total_amount') },
  ];

  return csvResponse(
    `${school.name}-families-${dateStamp()}.csv`,
    toCsv(rows, cols),
  );
}
