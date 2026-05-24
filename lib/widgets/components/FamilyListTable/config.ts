import type { ConfigSchema } from '@/lib/widgets/types';

export interface FamilyListTableConfig {
  // 'active' (default) | 'inactive' | 'withdrawn' | 'all'
  status_filter: string;
  // The dashboard slug to drill into when a row is clicked. Default
  // 'family-hub' — the only dashboard with detail_layout in v1.
  drilldown_dashboard_slug: string;
}

export const familyListTableDefaults: FamilyListTableConfig = {
  status_filter: 'active',
  drilldown_dashboard_slug: 'family-hub',
};

export const familyListTableSchema: ConfigSchema = {
  fields: [
    {
      type: 'select',
      key: 'status_filter',
      label: 'Status filter',
      options: [
        { value: 'active', label: 'Active families' },
        { value: 'inactive', label: 'Inactive families' },
        { value: 'withdrawn', label: 'Withdrawn families' },
        { value: 'all', label: 'All families' },
      ],
    },
    {
      type: 'text',
      key: 'drilldown_dashboard_slug',
      label: 'Drill-down dashboard slug',
      help: 'Slug of the dashboard to open when a family row is clicked. Defaults to family-hub.',
    },
  ],
};
