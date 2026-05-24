// RostersHub — multi-tab roster widget. Operator picks which tabs to
// show per school. Each tab is a pre-built filter over students/families.

import type { ConfigSchema } from '@/lib/widgets/types';

export const AVAILABLE_TABS = [
  { key: 'school_year',    label: 'School Year',    help: 'Currently enrolled students' },
  { key: 'summer',         label: 'Summer',         help: 'Students with summer-program data on file' },
  { key: 'sst',            label: 'SST',            help: 'Student Success Team participants' },
  { key: 'enrichment',     label: 'Enrichment',     help: 'Students with an enrichment (service_1) entry' },
  { key: 'sports',         label: 'Sports',         help: 'Students with a sports (service_2) entry' },
  { key: 'hearing_vision', label: 'Hearing & Vision', help: 'Students with H&V screenings recorded' },
  { key: 'esa',            label: 'ESA Recipients', help: 'AZ Empowerment Scholarship Account recipients' },
  { key: 'sto',            label: 'STO Recipients', help: 'School Tuition Organization recipients (by type)' },
  { key: 'fin_aid',        label: 'Financial Aid',  help: 'Need-based aid recipients (financial_aid > 0)' },
  { key: 'employee_kids',  label: 'Employees’ Kids', help: 'Students whose parent is staff' },
  { key: 'siblings',       label: 'Siblings',       help: 'Families with more than one student' },
  { key: 'schedule',       label: 'Daily Schedule', help: 'School Day / Extended Day / Half Day breakdown' },
  { key: 'referrals',      label: 'Referrals',      help: 'Students with a referrer recorded' },
] as const;

export type TabKey = typeof AVAILABLE_TABS[number]['key'];

export interface RostersHubConfig {
  shown_tabs: TabKey[];
  default_tab?: TabKey;
  drilldown_dashboard_slug?: string;
}

export const rostersHubDefaults: RostersHubConfig = {
  shown_tabs: [
    'school_year', 'summer', 'sst', 'enrichment', 'sports',
    'hearing_vision', 'esa', 'sto', 'fin_aid', 'employee_kids',
    'siblings', 'schedule', 'referrals',
  ],
  default_tab: 'school_year',
  drilldown_dashboard_slug: 'family-hub',
};

export const rostersHubSchema: ConfigSchema = {
  fields: [],
};
