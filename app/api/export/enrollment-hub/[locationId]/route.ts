// CSV export — EnrollmentHubTable. Honors the same searchParams as the
// widget (q, status, program, homeroom, schedule, year, lead_teacher,
// iep, 504_plan, allergy) so the export matches what the operator sees
// on screen.

import type { NextRequest } from 'next/server';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher as enrollmentFetcher, type StudentRow } from '@/lib/widgets/components/EnrollmentHubTable/fetcher';
import { enrollmentHubDefaults } from '@/lib/widgets/components/EnrollmentHubTable/config';
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

  const data = await enrollmentFetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    enrollmentHubDefaults,
    sp,
  );

  const cols: CsvColumn<StudentRow>[] = [
    { key: 'student',    label: 'Student',          value: (s) => `${s.preferred_name || s.first_name} ${s.last_name}` },
    { key: 'family',     label: 'Family',           value: (s) => s.family_display_name ?? `${s.last_name} Family` },
    { key: 'dob',        label: 'DOB',              value: (s) => s.date_of_birth ?? '' },
    { key: 'status',     label: 'Status',           value: (s) => (s.status ?? '').replace(/_/g, ' ') },
    { key: 'program',    label: 'Program',          value: (s) => s.program ?? s.classroom_name ?? '' },
    { key: 'year',       label: 'Academic year',    value: (s) => s.academic_year ?? '' },
    { key: 'homeroom',   label: 'Homeroom',         value: (s) => s.homeroom ?? s.classroom_name ?? '' },
    { key: 'teacher',    label: 'Lead teacher',     value: (s) => s.lead_teacher_name ?? '' },
    { key: 'schedule',   label: 'Schedule',         value: (s) => s.schedule ?? '' },
    { key: 'enrolled',   label: 'Enrolled at',      value: (s) => s.enrolled_at ?? '' },
    { key: 'iep',        label: 'IEP',              value: (s) => s.iep ?? '' },
    { key: 'plan_504',   label: '504',              value: (s) => s.five04_plan ?? '' },
    { key: 'allergy',    label: 'Allergy',          value: (s) => s.allergy ?? '' },
  ];

  return csvResponse(
    `${school.name}-enrollment-${dateStamp()}.csv`,
    toCsv(data.filtered, cols),
  );
}
