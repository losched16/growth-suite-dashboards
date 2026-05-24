// CSV export — RostersHub. `?tab=<key>` picks which roster to export.
// Defaults to school_year if omitted.

import type { NextRequest } from 'next/server';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher as rostersFetcher, TAB_PREDICATES, type RosterStudentRow } from '@/lib/widgets/components/RostersHub/fetcher';
import { rostersHubDefaults, type TabKey } from '@/lib/widgets/components/RostersHub/config';

type Params = Promise<{ locationId: string }>;

const TAB_LABELS: Record<TabKey, string> = {
  school_year: 'School Year',
  summer: 'Summer',
  sst: 'SST',
  enrichment: 'Enrichment',
  sports: 'Sports',
  hearing_vision: 'Hearing & Vision',
  esa: 'ESA Recipients',
  sto: 'STO Recipients',
  fin_aid: 'Financial Aid',
  employee_kids: 'Employees Kids',
  siblings: 'Siblings',
  schedule: 'Daily Schedule',
  referrals: 'Referrals',
};

function colsForTab(tab: TabKey): CsvColumn<RosterStudentRow>[] {
  const base: CsvColumn<RosterStudentRow> = {
    key: 'student',
    label: 'Student',
    value: (r) => `${r.preferred_name || r.first_name} ${r.last_name}`,
  };
  const parent: CsvColumn<RosterStudentRow> = { key: 'parent', label: 'Parent', value: (r) => r.primary_parent_name };
  const email: CsvColumn<RosterStudentRow> = { key: 'email', label: 'Email', value: (r) => r.primary_parent_email ?? '' };

  switch (tab) {
    case 'school_year':
      return [
        base, parent, email,
        { key: 'gender',  label: 'Gender', value: (r) => r.gender ?? '' },
        { key: 'dob',     label: 'DOB',    value: (r) => r.date_of_birth ?? '' },
        { key: 'program', label: 'Program', value: (r) => r.program ?? '' },
        { key: 'homeroom', label: 'Homeroom', value: (r) => r.homeroom ?? r.classroom_name ?? '' },
        { key: 'sched',   label: 'Schedule', value: (r) => r.schedule ?? '' },
        { key: 'status',  label: 'Status',   value: (r) => r.enrollment_status ?? '' },
        { key: 'started', label: 'Started',  value: (r) => r.enrolled_at ?? '' },
      ];
    case 'summer':
      return [
        base, parent, email,
        { key: 'sp',     label: 'Summer program', value: (r) => r.summer_program ?? '' },
        { key: 'ss',     label: 'Schedule',       value: (r) => r.summer_schedule ?? '' },
        { key: 'sc',     label: 'Classroom',      value: (r) => r.summer_classroom ?? '' },
        { key: 'sfd',    label: 'Form received',  value: (r) => r.summer_form_received_date ?? '' },
        { key: 'jun',    label: 'June',           value: (r) => r.summer_month_june ?? '' },
        { key: 'jul',    label: 'July',           value: (r) => r.summer_month_july ?? '' },
        { key: 'lunch',  label: 'Lunch',          value: (r) => r.summer_lunch ?? '' },
      ];
    case 'sst':
      return [
        base, parent, email,
        { key: 'sst_status', label: 'SST status',    value: (r) => r.sst_status ?? '' },
        { key: 'sst_start',  label: 'Start date',    value: (r) => r.sst_start_date ?? '' },
        { key: 'sst_fee',    label: 'SST fee',       value: (r) => r.sst_fee },
      ];
    case 'enrichment':
      return [
        base, parent, email,
        { key: 'service', label: 'Enrichment',      value: (r) => r.service_1 ?? '' },
        { key: 'hr',      label: 'Homeroom',        value: (r) => r.homeroom ?? r.classroom_name ?? '' },
        { key: 'bill',    label: 'Bill',            value: (r) => r.service_1_bill },
      ];
    case 'sports':
      return [
        base, parent, email,
        { key: 'service', label: 'Sport',           value: (r) => r.service_2 ?? '' },
        { key: 'hr',      label: 'Homeroom',        value: (r) => r.homeroom ?? r.classroom_name ?? '' },
        { key: 'bill',    label: 'Bill',            value: (r) => r.service_2_bill },
      ];
    case 'hearing_vision':
      return [
        base, parent, email,
        { key: 'hr',     label: 'Homeroom',         value: (r) => r.homeroom ?? r.classroom_name ?? '' },
        { key: 'fall',   label: 'Fall screening',   value: (r) => r.hearing_vision_fall ?? '' },
        { key: 'spring', label: 'Spring screening', value: (r) => r.hearing_vision_spring ?? '' },
      ];
    case 'esa':
      return [
        base, parent, email,
        { key: 'esa_rec', label: 'ESA recipient', value: (r) => r.esa_recipient ?? '' },
        { key: 'esa_amt', label: 'ESA amount',    value: (r) => r.esa_amount },
      ];
    case 'sto':
      return [
        base, parent, email,
        { key: 'sto_rec',  label: 'STO recipient', value: (r) => r.sto_recipient ?? '' },
        { key: 'sto_type', label: 'STO type',      value: (r) => r.sto_type ?? '' },
        { key: 'sto_amt',  label: 'STO amount',    value: (r) => r.sto_amount },
      ];
    case 'fin_aid':
      return [
        base, parent, email,
        { key: 'program', label: 'Program', value: (r) => r.program ?? '' },
        { key: 'tuition', label: 'Tuition', value: (r) => r.tuition_fee },
        { key: 'aid',     label: 'Financial aid', value: (r) => r.financial_aid },
        { key: 'net',     label: 'Net (tuition − aid)', value: (r) => r.tuition_fee - r.financial_aid },
      ];
    case 'employee_kids':
      return [
        base, parent, email,
        { key: 'emp_kid',  label: 'Employee kid flag', value: (r) => r.employee_kid ?? '' },
        { key: 'tuition',  label: 'Tuition',           value: (r) => r.tuition_fee },
        { key: 'emp_disc', label: 'Employee discount', value: (r) => r.employee_discount },
      ];
    case 'siblings':
      // This tab groups by family — we return one row per student with family + sibling discount
      return [
        base, parent, email,
        { key: 'fam',      label: 'Family',  value: (r) => r.family_display_name ?? '' },
        { key: 'tuition',  label: 'Tuition', value: (r) => r.tuition_fee },
        { key: 'sib_disc', label: 'Sibling discount', value: (r) => r.sibling_discount },
      ];
    case 'schedule':
      return [
        base, parent, email,
        { key: 'sched',  label: 'Schedule',     value: (r) => r.schedule ?? '' },
        { key: 'hr',     label: 'Homeroom',     value: (r) => r.homeroom ?? r.classroom_name ?? '' },
        { key: 'teach',  label: 'Lead teacher', value: (r) => r.lead_teacher_name ?? '' },
        { key: 'status', label: 'Status',       value: (r) => r.enrollment_status ?? '' },
      ];
    case 'referrals':
      return [
        base, parent, email,
        { key: 'ref',  label: 'Referred by',     value: (r) => r.referred_by ?? '' },
        { key: 'cred', label: 'Referral credit', value: (r) => r.referral_credit },
        { key: 'date', label: 'Enrolled date',   value: (r) => r.enrolled_at ?? '' },
      ];
  }
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const tab = (request.nextUrl.searchParams.get('tab') ?? 'school_year') as TabKey;
  if (!(tab in TAB_LABELS)) {
    return new Response(`Unknown tab: ${tab}`, { status: 400 });
  }

  const data = await rostersFetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    rostersHubDefaults,
  );

  let rows: RosterStudentRow[];
  if (tab === 'siblings') {
    // For siblings tab: students whose family has >1 student
    const sibFamilyIds = new Set(data.families.filter((f) => f.student_count > 1).map((f) => f.family_id));
    rows = data.students.filter((s) => sibFamilyIds.has(s.family_id));
  } else {
    const pred = TAB_PREDICATES[tab];
    rows = pred ? data.students.filter(pred) : data.students;
  }

  return csvResponse(
    `${school.name}-rosters-${tab}-${dateStamp()}.csv`,
    toCsv(rows, colsForTab(tab)),
  );
}
