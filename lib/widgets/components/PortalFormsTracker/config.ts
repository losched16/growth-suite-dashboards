// PortalFormsTracker — DocumentTracker-style UX over portal_form_submissions.
//
// Same family-row + per-student chips visual as DocumentTracker, but
// driven by actual parent-portal submissions (not student.metadata).
// One row per enrolled family, one column per active parent-portal form.

import type { ConfigSchema } from '@/lib/widgets/types';

// Office-recorded item tracked from students.metadata instead of portal
// submissions — for paperwork that comes back OUTSIDE the portal (e.g. a
// paper AZ emergency card, or a GHL Documents & Contracts signature). The
// office flips a per-student GHL custom field ("Student 1 AZ Card" →
// mirrored by the sync to metadata.az_card) and the item renders as one
// more per-student column in the grid, counted in every stat. Configured
// via layout JSON; no schema UI yet.
export interface ExternalTrackedItem {
  // Stable column id (the synthetic form id is `external:<key>`).
  key: string;
  // Column header, e.g. 'AZ Emergency Card'.
  label: string;
  // students.metadata key the sync mirrors from the GHL per-student field.
  metadata_key: string;
  // Values (case-insensitive) that count as complete.
  // Default: ['complete', 'yes', 'done'].
  complete_values?: string[];
}

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
  // Include students whose current-year enrollment status is 'pending'
  // alongside the enrolled. ON by default: pending families are exactly
  // the ones mid-paperwork (they aren't enrolled until their forms are
  // done), so the forms hub is where they belong. The header keeps the
  // mix honest ("250 enrolled · 3 pending"). Turn off to pin the
  // tracker to currently-enrolled only (Student Roster scope).
  include_pending?: boolean;
  // Extra columns tracked from student metadata (see ExternalTrackedItem).
  external_items?: ExternalTrackedItem[];
}

export const portalFormsTrackerDefaults: PortalFormsTrackerConfig = {
  default_form_filter: 'all',
  default_status_filter: 'all',
  auto_refresh_ms: 60_000,
  drilldown: 'family-forms',
  categories: [],
  enrolled_tag: 'enrolled - 26/27',
  excluded_tag: 'withdrawn',
  include_pending: true,
};

export const portalFormsTrackerSchema: ConfigSchema = {
  fields: [
    { key: 'enrolled_tag', label: 'Enrolled tag (case-insensitive, leave empty for all families)', type: 'text' },
    { key: 'excluded_tag', label: 'Excluded tag (e.g. "withdrawn")', type: 'text' },
    { key: 'include_pending', label: 'Include pending (mid-admissions) students', type: 'boolean' },
    { key: 'auto_refresh_ms', label: 'Auto-refresh interval (ms, 0 = off)', type: 'number', min: 0, max: 600_000 },
  ],
};
