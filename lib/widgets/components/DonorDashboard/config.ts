// DonorDashboard config: per-instance knobs the operator can tweak.
// Defaults work out-of-the-box for DG; configurable for the future when
// other schools wire in DonorPerfect.

import type { ConfigSchema } from '@/lib/widgets/types';

// School year boundary: month (1-12) when the year flips. DG uses July,
// matching the academic calendar (a 2024-25 school year runs Jul 1 '24
// to Jun 30 '25). Calendar year = month 1.
export interface DonorDashboardConfig {
  school_year_start_month: number; // 1..12, default 7 (July)
  top_donors_limit: number;        // default 25
  // Donor-tier thresholds, applied against this-school-year giving.
  // major  >= major_donor_threshold
  // mid    [mid_donor_threshold, major_donor_threshold)
  // grass  < mid_donor_threshold (but > 0)
  major_donor_threshold: number;   // default 1000
  mid_donor_threshold: number;     // default 250
  // Years of history to chart on the annual report. Default 6.
  years_of_history: number;
}

export const donorDashboardDefaults: DonorDashboardConfig = {
  school_year_start_month: 7,
  top_donors_limit: 25,
  major_donor_threshold: 1000,
  mid_donor_threshold: 250,
  years_of_history: 6,
};

export const donorDashboardSchema: ConfigSchema = {
  fields: [
    {
      type: 'number',
      key: 'school_year_start_month',
      label: 'School year starts in month',
      min: 1,
      max: 12,
      help: 'Calendar year = 1, July (academic) = 7.',
    },
    {
      type: 'number',
      key: 'top_donors_limit',
      label: 'Top donors to list',
      min: 5,
      max: 200,
    },
    {
      type: 'number',
      key: 'major_donor_threshold',
      label: 'Major donor threshold ($)',
      min: 0,
      help: 'Annual giving >= this counts as a "major" donor.',
    },
    {
      type: 'number',
      key: 'mid_donor_threshold',
      label: 'Mid-level donor threshold ($)',
      min: 0,
      help: 'Annual giving >= this (but below major) is mid-level. Below is grassroots.',
    },
    {
      type: 'number',
      key: 'years_of_history',
      label: 'Years of history on annual chart',
      min: 1,
      max: 20,
    },
  ],
};
