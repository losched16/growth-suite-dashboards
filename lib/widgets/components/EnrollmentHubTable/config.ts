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
  { key: 're_enrolled',  label: 'Re-enrolled',    type: 'yesno'  as const },
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
  { key: 're_enrolled',  label: 'Re-enrolled' },
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

// An arbitrary GHL custom field surfaced as an extra table column. `key` is
// the raw key as it appears in students.metadata (e.g. "tuition_fee",
// "t_shirt_size"); `label` is the human heading shown to staff. This is what
// makes the hub "columns on ANY data" — schools add whatever GHL field they
// track without us shipping code per field.
export interface ExtraColumn {
  key: string;
  label: string;
}

// Internal plumbing keys that live in students.metadata but should never be
// offered as a selectable column. Everything else a school puts in GHL is
// fair game.
export const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'ghl_contact_id',
  'ghl_slot',
  'is_demo',
  're_enrolled',
  'student_id',
  'family_id',
]);

// Turn a raw GHL field key into a readable column heading:
//   "t_shirt_size" -> "T Shirt Size", "tuition_fee" -> "Tuition Fee".
export function humanizeFieldKey(key: string): string {
  return key
    .replace(/^contact\./, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface EnrollmentHubConfig {
  academic_year?: string;          // null = "any"
  shown_filters: FilterKey[];
  shown_columns: ColumnKey[];
  // Extra columns sourced from arbitrary GHL fields (students.metadata).
  // Rendered after the built-in columns. Empty/undefined = none (back-compat).
  extra_columns?: ExtraColumn[];
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
  // Show only students whose family has at least one parent carrying
  // this GHL tag. Mirrors PortalFormsTracker.enrolled_tag — the two
  // widgets stay in sync on what "enrolled" means. Default empty =
  // no tag filter (back-compat). Wooster sets this to
  // "enrolled - 26/27" alongside only_enrolled.
  enrolled_tag?: string;
  // Hide students whose family has any parent carrying this tag — for
  // withdrawn families. Empty = no exclusion.
  excluded_tag?: string;
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
