// Configuration for the rich Student Roster. Mirrors bespoke
// desert-garden-admin /students page: search + filters + view-mode toggle.
//
// View modes:
//   - 'list' (default) — full table
//   - 'grid' — card layout
//   - 'allergies' — allergies-by-classroom (printable)

import type { ConfigSchema } from '@/lib/widgets/types';

export const AVAILABLE_FILTERS = [
  { key: 'academic_year', label: 'School year', type: 'select' as const },
  { key: 'program', label: 'Program', type: 'select' as const },
  { key: 'homeroom', label: 'Homeroom', type: 'select' as const },
  { key: 'schedule', label: 'Schedule', type: 'select' as const },
  { key: 'lead_teacher', label: 'Teacher', type: 'select' as const },
  { key: 'gender', label: 'Gender', type: 'select' as const },
  { key: 'lunch', label: 'Lunch', type: 'select' as const },
  { key: 'attendance_status', label: 'Attendance', type: 'select' as const },
  { key: 'allergies_only', label: 'Allergies only', type: 'checkbox' as const },
  { key: 'iep_504_only', label: 'IEP/504 only', type: 'checkbox' as const },
  { key: 'lunch_only', label: 'Hot lunch only', type: 'checkbox' as const },
  { key: 'curbside_only', label: 'Curbside today', type: 'checkbox' as const },
  { key: 're_enrolled_only', label: 'Re-enrolled only', type: 'checkbox' as const },
] as const;

export type FilterKey = typeof AVAILABLE_FILTERS[number]['key'];

export const AVAILABLE_COLUMNS = [
  { key: 'student',              label: 'Student' },
  { key: 'last_name',            label: 'Last name' },
  { key: 'first_name',           label: 'First name' },
  { key: 'gender_age',           label: 'Gender / Age' },
  { key: 'age_aug1',             label: 'Age @ Aug 1' },
  { key: 'age_jan1',             label: 'Age @ Jan 1' },
  { key: 'program',              label: 'Program' },
  { key: 'homeroom',             label: 'Homeroom' },
  { key: 'lead_teacher',         label: 'Lead teacher' },
  { key: 'schedule',             label: 'Schedule' },
  { key: 'initial_start_date',   label: 'Initial start date' },
  { key: 'tuition',              label: 'Tuition' },
  { key: 'status',               label: 'Status' },
  { key: 'allergy',              label: 'Allergy' },
  { key: 'special_instructions', label: 'Special instructions' },
  { key: 'iep_504',              label: 'IEP/504' },
  { key: 'lunch',                label: 'Lunch' },
  { key: 'attendance',           label: 'Today\'s attendance' },
  { key: 'attendance_notes',     label: 'Check-in notes' },
  { key: 'pickup_restrictions',  label: 'NOT authorized pickup' },
  { key: 're_enrolled',          label: 'Re-enrolled' },
  { key: 'family',               label: 'Family' },
  { key: 'documents',            label: 'Documents' },
] as const;

export type ColumnKey = typeof AVAILABLE_COLUMNS[number]['key'];

// Built-in sections of the family detail panel (the row dropdown).
// Schools toggle these in the Customize builder; undefined config = all on.
export const DETAIL_SECTIONS = [
  { key: 'parents',             label: 'Parents (contact info)' },
  { key: 'students',            label: 'Students in family' },
  { key: 'authorized_pickups',  label: 'Authorized for pickup' },
  { key: 'pickup_restrictions', label: 'NOT authorized for pickup' },
  { key: 'per_student',         label: 'Per-student detail (health, enrollment, medical forms)' },
] as const;
export type DetailSectionKey = typeof DETAIL_SECTIONS[number]['key'];

export interface StudentRosterConfig {
  shown_filters: FilterKey[];
  shown_columns: ColumnKey[];
  enable_views: Array<'list' | 'grid' | 'allergies'>;
  page_size?: number;
  drilldown_dashboard_slug?: string;
  // Per-classroom dashboards set this so the roster pre-narrows to one
  // classroom without the operator having to pick the filter. URL param
  // `?homeroom=...` still wins if explicitly set (operator can override).
  default_homeroom_filter?: string;
  // Program-scoped dashboards (Upper El, MYHS) set this — these are
  // multi-classroom teacher groups where students share a program but
  // not a single homeroom. URL `?program=...` still wins.
  default_program_filter?: string;
  // Academic year the roster defaults to (e.g. '2026-27'). Falls back
  // to the current year in the fetcher when unset.
  default_academic_year?: string;
  // Self-serve filters/columns: attr_keys from school_filter_catalog
  // (e.g. 'tag', 'cf:donor_tier', 'opp_stage'). The school picks these
  // in the roster-settings builder; the fetcher resolves values via
  // students.metadata + the GHL attribute tables.
  extra_filters?: string[];
  extra_columns?: string[];
  // Saved column order (built-in + added keys interleaved). When set, the
  // roster + CSV export render the enabled columns in this order. Keys
  // not present here fall to the end; keys here but not enabled are
  // ignored. Edited via the "Column order" reorder list in Customize.
  column_order?: string[];
  // Row-dropdown (family detail panel) customization:
  //   detail_sections — which BUILT-IN sections render (undefined = all)
  //   detail_attrs    — catalog attr_keys shown as extra detail rows
  detail_sections?: string[];
  detail_attrs?: string[];
  // Restrict the roster to students whose GHL opportunity stage is in
  // this list (matched against students.metadata.ghl_stage_name). Used by
  // schools whose roster is still an admissions pipeline so the dashboard
  // shows only accepted/enrolled kids, not every prospective applicant.
  // Unset/empty = show all active students (default, unchanged behavior).
  enrolled_stage_names?: string[];
  // Audience for the documents inline cell:
  //   'teacher' → hide documents flagged visible_to_teacher=false
  //   'all'     → show every document (operator view, default)
  // Set per-dashboard via the provisioner — classroom hubs get
  // 'teacher' so admin-only files (HR notes, sensitive IEP drafts,
  // etc.) don't leak.
  documents_audience?: 'teacher' | 'all';
}

export const studentRosterDefaults: StudentRosterConfig = {
  shown_filters: ['academic_year', 'program', 'homeroom', 'schedule', 'allergies_only', 'iep_504_only'],
  shown_columns: ['student', 'gender_age', 'program', 'homeroom', 'lead_teacher', 'schedule', 'tuition', 'status', 'allergy', 'special_instructions', 'iep_504', 'documents', 'family'],
  enable_views: ['list', 'grid', 'allergies'],
  page_size: 100,
  drilldown_dashboard_slug: 'family-hub',
};

// Order the set of ENABLED columns by the saved column_order: ordered
// keys first (those still enabled), then any enabled key not in the
// saved order, appended in their natural order. Shared by the roster
// render + the CSV export so the spreadsheet matches the screen.
export function orderColumns(order: string[] | undefined, enabled: string[]): string[] {
  if (!order || order.length === 0) return enabled;
  const enabledSet = new Set(enabled);
  const orderSet = new Set(order);
  const front = order.filter((k) => enabledSet.has(k));
  const rest = enabled.filter((k) => !orderSet.has(k));
  return [...front, ...rest];
}

export const studentRosterSchema: ConfigSchema = {
  fields: [
    { key: 'page_size', label: 'Rows per page', type: 'number', min: 25, max: 1000 },
  ],
};
