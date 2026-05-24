// Configuration schema for the rich Enrollment Hub widget. Per-school
// operator picks which filters and columns to show. The widget code
// defines the full superset; school config picks the subset.

import type { ConfigSchema } from '@/lib/widgets/types';

// Every filter the widget knows how to render. Operators pick a subset
// per school via shown_filters in the instance config.
export const AVAILABLE_FILTERS = [
  { key: 'status',       label: 'Status',         type: 'select' as const },
  { key: 'program',      label: 'Program',        type: 'select' as const },
  { key: 'homeroom',     label: 'Homeroom',       type: 'select' as const },
  { key: 'schedule',     label: 'Schedule',       type: 'select' as const },
  { key: 'year',         label: 'Year',           type: 'select' as const },
  { key: 'lead_teacher', label: 'Lead teacher',   type: 'select' as const },
  { key: 'iep',          label: 'IEP',            type: 'yesno'  as const },
  { key: '504_plan',     label: '504 plan',       type: 'yesno'  as const },
  { key: 'allergy',      label: 'Has allergy',    type: 'yesno'  as const },
] as const;

export type FilterKey = typeof AVAILABLE_FILTERS[number]['key'];

export const AVAILABLE_COLUMNS = [
  { key: 'student',      label: 'Student' },
  { key: 'dob',          label: 'DOB' },
  { key: 'age',          label: 'Age' },
  { key: 'status',       label: 'Status' },
  { key: 'program',      label: 'Program' },
  { key: 'year',         label: 'Year' },
  { key: 'homeroom',     label: 'Grade / Homeroom' },
  { key: 'lead_teacher', label: 'Lead teacher' },
  { key: 'schedule',     label: 'Schedule' },
  { key: 'started',      label: 'Started' },
  { key: 'family',       label: 'Family' },
  { key: 'iep',          label: 'IEP' },
  { key: '504_plan',     label: '504' },
  { key: 'allergy',      label: 'Allergy' },
] as const;

export type ColumnKey = typeof AVAILABLE_COLUMNS[number]['key'];

export interface EnrollmentHubConfig {
  academic_year?: string;          // null = "any"
  shown_filters: FilterKey[];
  shown_columns: ColumnKey[];
  show_stat_cards?: boolean;       // default true
  show_breakdowns?: boolean;       // default true
  drilldown_dashboard_slug?: string; // default 'family-hub'
  // When true, the SQL-level roster is restricted to enrollments with
  // status='enrolled'. Schools whose data layer doesn't strictly
  // separate prospects from enrolled students (e.g. Wooster, where GHL
  // tag membership is the only signal) should turn this on so the
  // hub never surfaces a curious "interested" lead alongside actual
  // students. Default off to match DGM's behavior (which renders the
  // full pipeline and lets stat cards break it down).
  only_enrolled?: boolean;
}

export const enrollmentHubDefaults: EnrollmentHubConfig = {
  academic_year: '2026-27',
  shown_filters: ['status', 'program', 'homeroom', 'schedule'],
  shown_columns: ['student', 'dob', 'age', 'status', 'program', 'year', 'homeroom', 'lead_teacher', 'schedule', 'started', 'family'],
  show_stat_cards: true,
  show_breakdowns: true,
  drilldown_dashboard_slug: 'family-hub',
};

export const enrollmentHubSchema: ConfigSchema = {
  fields: [
    { key: 'academic_year', label: 'Academic year (blank = any)', type: 'text' },
  ],
};
