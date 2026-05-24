// Configuration for the rich Family Hub widget. Mirrors the bespoke
// desert-garden-admin /families page (search + filters + sortable table)
// but generalized so other schools can pick which filters/columns to show.

import type { ConfigSchema } from '@/lib/widgets/types';

export const AVAILABLE_FILTERS = [
  { key: 'family_status', label: 'Family status', type: 'select' as const },
  { key: 'enrollment_status', label: 'Enrollment', type: 'select' as const },
  { key: 'program', label: 'Program', type: 'select' as const },
  { key: 'payment_plan', label: 'Payment plan', type: 'select' as const },
  { key: 'homeroom', label: 'Homeroom', type: 'select' as const },
  { key: 'has_allergy', label: 'Has allergy', type: 'yesno' as const },
] as const;

export type FilterKey = typeof AVAILABLE_FILTERS[number]['key'];

export const AVAILABLE_COLUMNS = [
  { key: 'family', label: 'Family' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'students', label: 'Students' },
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'programs', label: 'Programs' },
  { key: 'payment_plan', label: 'Payment plan' },
  { key: 'total_tuition', label: 'Total tuition' },
  { key: 'active', label: 'Active' },
] as const;

export type ColumnKey = typeof AVAILABLE_COLUMNS[number]['key'];

export type SortKey = 'family' | 'students' | 'enrollment' | 'payment_plan' | 'total_tuition' | 'active';

export interface FamilyHubConfig {
  shown_filters: FilterKey[];
  shown_columns: ColumnKey[];
  show_stat_cards?: boolean;
  page_size?: number;        // default 50
  drilldown_dashboard_slug?: string;
}

export const familyHubDefaults: FamilyHubConfig = {
  shown_filters: ['family_status', 'enrollment_status', 'program', 'payment_plan'],
  shown_columns: ['family', 'phone', 'students', 'enrollment', 'payment_plan', 'total_tuition', 'active'],
  show_stat_cards: true,
  page_size: 50,
  drilldown_dashboard_slug: 'family-hub',
};

export const familyHubSchema: ConfigSchema = {
  fields: [
    { key: 'page_size', label: 'Rows per page', type: 'number', min: 10, max: 500 },
  ],
};
