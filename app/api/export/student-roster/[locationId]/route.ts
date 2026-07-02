// CSV export — Student Roster. Honors the school's customized columns
// (built-in + added Growth Suite / FACTS fields), in their saved order,
// and the current on-screen filters (passed through as query params).
// One row per student → drops straight into Excel next to a FACTS sheet.
//
// GET /api/export/student-roster/{locationId}?<same filter params as the roster>

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExportPublic, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher, type RosterStudent } from '@/lib/widgets/components/StudentRosterRich/fetcher';
import { studentRosterDefaults, orderColumns, type StudentRosterConfig } from '@/lib/widgets/components/StudentRosterRich/config';
import type { WidgetSearchParams } from '@/lib/widgets/types';

type Params = Promise<{ locationId: string }>;

// Built-in column → { header, value }. Anything not here is treated as a
// dynamic (added) column resolved from the student's `dynamic` map.
const BASE: Record<string, { label: string; value: (s: RosterStudent) => string | number }> = {
  student:        { label: 'Student',          value: (s) => `${s.preferred_name || s.first_name} ${s.last_name}`.trim() },
  first_name:     { label: 'First Name',       value: (s) => s.preferred_name || s.first_name },
  last_name:      { label: 'Last Name',        value: (s) => s.last_name },
  gender_age:     { label: 'Gender / Age',     value: (s) => [s.gender, s.age_as_of_aug1].filter(Boolean).join(' · ') },
  age_aug1:       { label: 'Age @ Aug 1',      value: (s) => s.age_as_of_aug1 },
  age_jan1:       { label: 'Age @ Jan 1',      value: (s) => s.age_as_of_jan1 },
  program:        { label: 'Program',          value: (s) => s.program ?? s.classroom_name ?? '' },
  homeroom:       { label: 'Homeroom',         value: (s) => s.homeroom ?? s.classroom_name ?? '' },
  lead_teacher:   { label: 'Lead Teacher',     value: (s) => s.lead_teacher_name ?? '' },
  schedule:       { label: 'Schedule',         value: (s) => s.schedule ?? '' },
  tuition:        { label: 'Tuition',          value: (s) => s.tuition ?? '' },
  status:         { label: 'Status',           value: (s) => s.status ?? '' },
  initial_start_date: { label: 'Initial Start Date', value: (s) => s.initial_start_date ?? '' },
  allergy:        { label: 'Allergy',          value: (s) => s.allergy ?? '' },
  special_instructions: { label: 'Special Instructions', value: (s) => s.special_instructions ?? '' },
  iep_504:        { label: 'IEP / 504',        value: (s) => [s.iep, s.five04_plan].filter((v) => v && v.toLowerCase() !== 'no').join(' / ') },
  documents:      { label: 'Documents',        value: (s) => s.documents_count },
  address:        { label: 'Home Address',     value: (s) => s.address ?? '' },
  family:         { label: 'Family',           value: (s) => s.family_display_name ?? s.primary_parent_name },
  lunch:          { label: 'Lunch',            value: (s) => s.lunch ?? '' },
  attendance:     { label: 'Attendance',       value: (s) => s.attendance_status ?? '' },
  re_enrolled:    { label: 'Re-enrolled',      value: (s) => (s.re_enrolled ? 'Yes' : '') },
};

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExportPublic(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  // Pull the school's saved roster config (their column choices + order).
  const { rows: dashRows } = await query<{ layout: Array<{ widget_id: string; config: Partial<StudentRosterConfig> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
    [school.id],
  );
  const saved = dashRows[0]?.layout?.find((w) => w.widget_id === 'student_roster_rich')?.config ?? {};
  const config: StudentRosterConfig = { ...studentRosterDefaults, ...saved };

  const sp: WidgetSearchParams = {};
  for (const [k, v] of request.nextUrl.searchParams.entries()) {
    if (k === 'embed_token' || k === 'view') continue;
    if (v) sp[k] = v;
  }

  const data = await fetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    config,
    sp,
  );

  // Column order = the school's saved order, over the enabled columns.
  const orderedKeys = orderColumns(config.column_order, [
    ...(config.shown_columns ?? studentRosterDefaults.shown_columns ?? []),
    ...(config.extra_columns ?? []),
  ]);
  const cols: CsvColumn<RosterStudent>[] = orderedKeys.map((key) => {
    const base = BASE[key];
    if (base) return { key, label: base.label, value: base.value };
    // Dynamic column (cf:*, facts:*, tag, opp_*) — label from the
    // resolved catalog labels, value from the student's dynamic map.
    return { key, label: data.dynamic_labels[key] ?? key, value: (s) => s.dynamic[key] ?? '' };
  });

  return csvResponse(`student-roster-${dateStamp()}.csv`, toCsv(data.filtered, cols));
}
