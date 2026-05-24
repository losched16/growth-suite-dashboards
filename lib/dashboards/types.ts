import type { WidgetInstance } from '@/lib/widgets/types';

// A dashboard's static definition (in code). Defines what a "Document
// Tracker" or "Family Hub" IS. Per-school overrides (custom layout, custom
// display name, enabled toggle) live in the DB on school_dashboards rows.
export interface DashboardDefinition {
  slug: string;
  display_name: string;
  description: string;
  icon: string;                                // lucide-react icon name
  default_layout: WidgetInstance[];
  // Used when drilling into a sub-resource (e.g. one family on Family Hub).
  detail_layout?: WidgetInstance[];
}

// As stored in the school_dashboards table.
export interface SchoolDashboardRow {
  id: string;
  school_id: string;
  dashboard_slug: string;
  display_name: string;
  description: string | null;
  layout: WidgetInstance[];
  is_enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}
