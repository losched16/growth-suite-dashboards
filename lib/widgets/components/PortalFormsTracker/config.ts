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
}

export const portalFormsTrackerDefaults: PortalFormsTrackerConfig = {
  default_form_filter: 'all',
  default_status_filter: 'all',
  auto_refresh_ms: 60_000,
  drilldown: 'family-forms',
  categories: [],
};

export const portalFormsTrackerSchema: ConfigSchema = {
  fields: [
    { key: 'auto_refresh_ms', label: 'Auto-refresh interval (ms, 0 = off)', type: 'number', min: 0, max: 600_000 },
  ],
};
