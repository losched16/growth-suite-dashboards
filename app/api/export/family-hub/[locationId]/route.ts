// CSV export — FamilyHubTable. Honors search + status/enrollment/program/
// plan/homeroom/has_allergy filters from the widget URL state.

import type { NextRequest } from 'next/server';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher as familyFetcher, type FamilyRow } from '@/lib/widgets/components/FamilyHubTable/fetcher';
import { familyHubDefaults } from '@/lib/widgets/components/FamilyHubTable/config';
import type { WidgetSearchParams } from '@/lib/widgets/types';

type Params = Promise<{ locationId: string }>;

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
    familyHubDefaults,
    sp,
  );

  const cols: CsvColumn<FamilyRow>[] = [
    { key: 'family',      label: 'Family',           value: (f) => f.family_display_name ?? `${f.primary_parent_name} Family` },
    { key: 'parent',      label: 'Primary parent',   value: (f) => f.primary_parent_name },
    { key: 'email',       label: 'Email',            value: (f) => f.primary_parent_email ?? '' },
    { key: 'phone',       label: 'Phone',            value: (f) => f.primary_parent_phone ?? '' },
    { key: 'parents',     label: 'Parents on file',  value: (f) => f.parent_count },
    { key: 'students',    label: 'Students',         value: (f) => f.student_count },
    { key: 'names',       label: 'Student names',    value: (f) => f.student_names },
    { key: 'enrollment',  label: 'Enrollment',       value: (f) => f.enrollment_summary.replace(/_/g, ' ') },
    { key: 'programs',    label: 'Programs',         value: (f) => f.programs },
    { key: 'plan',        label: 'Payment plan',     value: (f) => f.payment_plan },
    { key: 'tuition',     label: 'Total tuition',    value: (f) => f.total_tuition },
    { key: 'allergy',     label: 'Has allergy',      value: (f) => f.has_allergy ? 'yes' : 'no' },
    { key: 'active',      label: 'Family status',    value: (f) => f.family_status },
  ];

  return csvResponse(
    `${school.name}-families-${dateStamp()}.csv`,
    toCsv(data.filtered, cols),
  );
}
