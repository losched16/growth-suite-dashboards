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
  // When true, the hub counts ONLY students whose current-year enrollment
  // is 'enrolled' (and drops families with no enrolled student), so the
  // Family Hub agrees with the Student Roster's enrolled_only scope.
  // academic_year picks which year is "current" (falls back to the
  // student's most-recent enrollment when blank). Default off = unchanged
  // behavior (all active students) so other tenants aren't affected.
  only_enrolled?: boolean;
  academic_year?: string;
  // Default value for the Enrollment filter on first load (URL param absent),
  // e.g. 'enrolled' so the hub opens showing enrolled families. Still fully
  // switchable — the user can pick withdrawn/pending or "all". Empty/unset =
  // no default (shows all), so other tenants are unaffected. The filter's
  // "all" option submits the sentinel value `all` (not empty) so the choice
  // survives pagination/sort links.
  default_enrollment_status?: string;
  // Self-serve extras (mirror of the Student Roster's mechanism). All
  // resolved from school_filter_catalog + the GHL attribute tables via
  // resolveFamilyGhlAttrs — GHL stays the source of truth.
  //   extra_columns — catalog attr_keys shown as ADDED table columns
  //   detail_attrs  — catalog attr_keys shown as extra rows in the
  //                   expanded family accordion (the 40+ field report)
  //   column_order  — saved display order of the enabled columns
  //                   (built-in shown_columns + extra_columns interleaved)
  extra_columns?: string[];
  detail_attrs?: string[];
  column_order?: string[];
  // Hide the ⚙ Customize link (e.g. teacher dashboards). Default true
  // (office family hubs unchanged).
  show_customize?: boolean;
}

export const familyHubDefaults: FamilyHubConfig = {
  shown_filters: ['family_status', 'enrollment_status', 'program', 'payment_plan'],
  shown_columns: ['family', 'phone', 'students', 'enrollment', 'payment_plan', 'total_tuition', 'active'],
  show_stat_cards: true,
  page_size: 50,
  drilldown_dashboard_slug: 'family-hub',
};

// Order the set of ENABLED columns by the saved column_order: ordered
// keys first (those still enabled), then any enabled key not in the
// saved order, appended in their natural order. Shared by the hub render
// so added columns land where the school arranged them. (Copied verbatim
// from StudentRosterRich/config.ts.)
export function orderColumns(order: string[] | undefined, enabled: string[]): string[] {
  if (!order || order.length === 0) return enabled;
  const enabledSet = new Set(enabled);
  const orderSet = new Set(order);
  const front = order.filter((k) => enabledSet.has(k));
  const rest = enabled.filter((k) => !orderSet.has(k));
  return [...front, ...rest];
}

export const familyHubSchema: ConfigSchema = {
  fields: [
    { key: 'page_size', label: 'Rows per page', type: 'number', min: 10, max: 500 },
  ],
};
