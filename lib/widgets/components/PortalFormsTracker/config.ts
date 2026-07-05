// PortalFormsTracker — DocumentTracker-style UX over portal_form_submissions.
//
// Same family-row + per-student chips visual as DocumentTracker, but
// driven by actual parent-portal submissions (not student.metadata).
// One row per enrolled family, one column per active parent-portal form.

import type { ConfigSchema } from '@/lib/widgets/types';

export interface PortalFormsTrackerConfig {
  // Optional default form filter; 'all' shows every column.
  default_form_filter?: string;
  default_status_filter?: 'all' | 'complete' | 'in_progress' | 'not_started';
  // Auto-refresh interval (ms). 0 = off. Default 60s.
  auto_refresh_ms?: number;
  // Drilldown — when an admin clicks a family name. Defaults to the
  // per-family forms drill-down we just shipped at
  // /school/[loc]/families/[familyId]/forms.
  drilldown: 'family-forms' | 'family-hub';
  // Category filter: limit to these form categories ([] = all).
  categories?: string[];
  // Enrollment-tag filter (case-insensitive). When set, the tracker
  // only shows families where at least one parent's GHL contact has
  // this tag. Designed for "enrolled - 26/27"-style annual rollover —
  // bump the value each new school year. Empty / omitted = show all.
  enrolled_tag?: string;
  // Exclusion tag (case-insensitive). When a parent's GHL contact has
  // this tag, the family is hidden from the tracker. Pairs with the
  // GHL workflow Joe set up: tag a contact "withdrawn" → they fall
  // out of the dashboards on the next refresh.
  excluded_tag?: string;
  // Also include students whose current-year enrollment status is
  // 'pending' (mid-admissions families doing their enrollment
  // paperwork). Off by default: the tracker counts ONLY
  // currently-enrolled students — the same strict GHL
  // enrollment-status rule as the Student Roster, so the two agree.
  include_pending?: boolean;
}

export const portalFormsTrackerDefaults: PortalFormsTrackerConfig = {
  default_form_filter: 'all',
  default_status_filter: 'all',
  auto_refresh_ms: 60_000,
  drilldown: 'family-forms',
  categories: [],
  enrolled_tag: 'enrolled - 26/27',
  excluded_tag: 'withdrawn',
  include_pending: false,
};

export const portalFormsTrackerSchema: ConfigSchema = {
  fields: [
    { key: 'enrolled_tag', label: 'Enrolled tag (case-insensitive, leave empty for all families)', type: 'text' },
    { key: 'excluded_tag', label: 'Excluded tag (e.g. "withdrawn")', type: 'text' },
    { key: 'include_pending', label: 'Also show pending (mid-admissions) students', type: 'boolean' },
    { key: 'auto_refresh_ms', label: 'Auto-refresh interval (ms, 0 = off)', type: 'number', min: 0, max: 600_000 },
  ],
};
