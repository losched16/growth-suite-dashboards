// DocumentTracker — Wooster-style document tracker widget. Family-row
// layout, one column per form, per-student chips inside each cell.
//
// Forms come from the per-school `school_forms` table — operators
// configure them via the parent-portal admin section. The widget reads
// completion values from `student.metadata.form_completion`, populated
// by the sync orchestrator.

import type { ConfigSchema } from '@/lib/widgets/types';

export interface DocumentTrackerConfig {
  // 'all' = show all configured forms. Set to a single form ID to focus.
  default_form_filter?: string;
  default_status_filter?: 'all' | 'complete' | 'in_progress' | 'not_started';
  // Auto-refresh interval (ms). 0 = no auto-refresh. Default 60s.
  auto_refresh_ms?: number;
  // Drill-through: clicking a family name opens this dashboard. Default 'family-hub'.
  drilldown_dashboard_slug?: string;
}

export const documentTrackerDefaults: DocumentTrackerConfig = {
  default_form_filter: 'all',
  default_status_filter: 'all',
  auto_refresh_ms: 60_000,
  drilldown_dashboard_slug: 'family-hub',
};

export const documentTrackerSchema: ConfigSchema = {
  fields: [
    { key: 'auto_refresh_ms', label: 'Auto-refresh interval (ms, 0 = off)', type: 'number', min: 0, max: 600_000 },
  ],
};
