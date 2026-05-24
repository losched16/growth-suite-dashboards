// Fetches one flat list of students-with-family-and-enrollment for the
// school. The widget filters into different roster views in-memory based
// on the active tab.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { RostersHubConfig } from './config';

export interface RosterStudentRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  primary_parent_name: string;
  primary_parent_email: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string | null;
  enrolled_at: string | null;
  // Pull-throughs from metadata (sync stores these)
  program: string | null;
  homeroom: string | null;
  iep: string | null;
  five04_plan: string | null;
  allergy: string | null;
  ghl_slot: number;
  // Wish-list-additional fields (read leniently from metadata)
  sst_status: string | null;
  sst_start_date: string | null;
  sst_fee: number;
  service_1: string | null;
  service_2: string | null;
  service_1_bill: number;
  service_2_bill: number;
  hearing_vision_fall: string | null;
  hearing_vision_spring: string | null;
  esa_amount: number;
  esa_recipient: string | null;
  sto_amount: number;
  sto_type: string | null;
  sto_recipient: string | null;
  financial_aid: number;
  employee_discount: number;
  sibling_discount: number;
  employee_kid: string | null;
  referred_by: string | null;
  referral_credit: number;
  tuition_fee: number;
  // Summer
  summer_program: string | null;
  summer_schedule: string | null;
  summer_classroom: string | null;
  summer_form_received_date: string | null;
  summer_month_june: string | null;
  summer_month_july: string | null;
  summer_lunch: string | null;
}

export interface FamilyMeta {
  family_id: string;
  student_count: number;
  family_display_name: string | null;
  primary_parent_name: string;
  primary_parent_email: string | null;
}

export interface RostersHubData {
  students: RosterStudentRow[];
  families: FamilyMeta[];
  // counts per tab key (so the tab bar can show live counts without
  // re-running the filters on the client)
  counts: Record<string, number>;
  total: number;
}

interface DbRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  primary_first: string | null;
  primary_last: string | null;
  primary_email: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string | null;
  enrolled_at: string | null;
  metadata: Record<string, unknown> | null;
  family_student_count: string;
}

function md(s: Record<string, unknown> | null, key: string): string | null {
  if (!s) return null;
  const v = s[key];
  if (v === null || v === undefined) return null;
  const str = typeof v === 'string' ? v : String(v);
  return str.trim() || null;
}

function mdNum(s: Record<string, unknown> | null, key: string): number {
  if (!s) return 0;
  const v = s[key];
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function ynActive(s: string | null): boolean {
  if (!s) return false;
  const v = s.trim().toLowerCase();
  return !!v && !['no', 'none', 'n/a', 'na', '0', 'false'].includes(v);
}

const TAB_PREDICATES: Record<string, (s: RosterStudentRow) => boolean> = {
  school_year:     (s) => !!s.enrollment_status && /enrolled|accepted/i.test(s.enrollment_status),
  summer:          (s) => !!s.summer_program || !!s.summer_schedule || !!s.summer_form_received_date,
  sst:             (s) => ynActive(s.sst_status),
  enrichment:      (s) => !!s.service_1,
  sports:          (s) => !!s.service_2,
  hearing_vision:  (s) => !!s.hearing_vision_fall || !!s.hearing_vision_spring,
  esa:             (s) => s.esa_amount > 0 || ynActive(s.esa_recipient),
  sto:             (s) => s.sto_amount > 0 || ynActive(s.sto_recipient) || !!s.sto_type,
  fin_aid:         (s) => s.financial_aid > 0,
  employee_kids:   (s) => ynActive(s.employee_kid),
  schedule:        (s) => !!s.schedule,
  referrals:       (s) => !!s.referred_by,
};

export async function fetcher(
  school: SchoolContext,
  _config: RostersHubConfig,
  _searchParams?: WidgetSearchParams,
): Promise<RostersHubData> {
  const { rows } = await query<DbRow>(
    `SELECT
       s.id AS student_id,
       s.family_id,
       f.display_name AS family_display_name,
       (SELECT first_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_first,
       (SELECT last_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_last,
       (SELECT email FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_email,
       s.first_name, s.last_name, s.preferred_name, s.date_of_birth, s.gender,
       e.status AS enrollment_status,
       e.academic_year,
       c.name AS classroom_name,
       c.lead_teacher_name,
       e.schedule,
       e.enrolled_at,
       s.metadata,
       (SELECT count(*) FROM students s2 WHERE s2.family_id = f.id AND s2.status = 'active')::int AS family_student_count
     FROM students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN LATERAL (
       SELECT * FROM enrollments e2 WHERE e2.student_id = s.id ORDER BY e2.created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.first_name`,
    [school.schoolId],
  );

  const students: RosterStudentRow[] = rows.map((r) => {
    const m = r.metadata;
    const primaryName = `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim() || '(unnamed)';
    return {
      student_id: r.student_id,
      family_id: r.family_id,
      family_display_name: r.family_display_name,
      primary_parent_name: primaryName,
      primary_parent_email: r.primary_email,
      first_name: r.first_name,
      last_name: r.last_name,
      preferred_name: r.preferred_name,
      date_of_birth: r.date_of_birth,
      gender: r.gender,
      enrollment_status: r.enrollment_status,
      classroom_name: r.classroom_name,
      lead_teacher_name: r.lead_teacher_name,
      schedule: r.schedule,
      academic_year: r.academic_year,
      enrolled_at: r.enrolled_at,
      program: md(m, 'program'),
      homeroom: md(m, 'homeroom'),
      iep: md(m, 'iep'),
      five04_plan: md(m, 'five04_plan'),
      allergy: md(m, 'allergy'),
      ghl_slot: typeof m?.ghl_slot === 'number' ? (m.ghl_slot as number) : Number(m?.ghl_slot ?? 1) || 1,
      sst_status: md(m, 'sst_status'),
      sst_start_date: md(m, 'sst_start_date'),
      sst_fee: mdNum(m, 'sst_fee'),
      service_1: md(m, 'service_1') ?? md(m, 'service1'),
      service_2: md(m, 'service_2') ?? md(m, 'service2'),
      service_1_bill: mdNum(m, 'service_1_bill_amount') || mdNum(m, 'service1BillAmount'),
      service_2_bill: mdNum(m, 'service_2_bill_amount') || mdNum(m, 'service2BillAmount'),
      hearing_vision_fall: md(m, 'hearing_and_vision_fall') ?? md(m, 'hearingVisionFall'),
      hearing_vision_spring: md(m, 'hearing_and_vision_spring') ?? md(m, 'hearingVisionSpring'),
      esa_amount: mdNum(m, 'esa_amount'),
      esa_recipient: md(m, 'esa_recipient'),
      sto_amount: mdNum(m, 'sto_amount'),
      sto_type: md(m, 'sto_type'),
      sto_recipient: md(m, 'sto_recipient'),
      financial_aid: mdNum(m, 'financial_aid'),
      employee_discount: mdNum(m, 'employee_discount'),
      sibling_discount: mdNum(m, 'sibling_discount'),
      employee_kid: md(m, 'employee_kid'),
      referred_by: md(m, 'referred_by') ?? md(m, 'referredBy'),
      referral_credit: mdNum(m, 'referral_credit'),
      tuition_fee: mdNum(m, 'tuition_fee') || mdNum(m, 'tuitionFee'),
      summer_program: md(m, 'summer_program') ?? md(m, 'summerProgram'),
      summer_schedule: md(m, 'summer_schedule') ?? md(m, 'summerSchedule'),
      summer_classroom: md(m, 'summer_classroom') ?? md(m, 'summerClassroom'),
      summer_form_received_date: md(m, 'summer_form_received_date') ?? md(m, 'summerFormReceivedDate'),
      summer_month_june: md(m, 'summer_month_june') ?? md(m, 'summerMonthJune'),
      summer_month_july: md(m, 'summer_month_july') ?? md(m, 'summerMonthJuly'),
      summer_lunch: md(m, 'summer_lunch') ?? md(m, 'summerLunch'),
    };
  });

  // Build per-family meta for siblings tab
  const famMap = new Map<string, FamilyMeta>();
  for (const r of rows) {
    if (famMap.has(r.family_id)) continue;
    famMap.set(r.family_id, {
      family_id: r.family_id,
      student_count: Number(r.family_student_count),
      family_display_name: r.family_display_name,
      primary_parent_name: `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim() || '(unnamed)',
      primary_parent_email: r.primary_email,
    });
  }
  const families = [...famMap.values()];

  // Pre-compute counts per tab
  const counts: Record<string, number> = {};
  for (const [tabKey, pred] of Object.entries(TAB_PREDICATES)) {
    counts[tabKey] = students.filter(pred).length;
  }
  counts.siblings = families.filter((f) => f.student_count > 1).length;

  return { students, families, counts, total: students.length };
}

// Re-exported so the index component can use the same predicate map
export { TAB_PREDICATES };
