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
  { key: 'gender_age',           label: 'Gender / Age' },
  { key: 'program',              label: 'Program' },
  { key: 'homeroom',             label: 'Homeroom' },
  { key: 'lead_teacher',         label: 'Lead teacher' },
  { key: 'schedule',             label: 'Schedule' },
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

export const studentRosterSchema: ConfigSchema = {
  fields: [
    { key: 'page_size', label: 'Rows per page', type: 'number', min: 25, max: 1000 },
  ],
};
