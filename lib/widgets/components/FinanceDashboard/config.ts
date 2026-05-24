// FinanceDashboard config. The program-group mapping is per-school
// configurable (different schools group their programs differently).
//
// Each group has a label and a list of regex-style match patterns
// applied against the student's `program` field. Falls back to bucketing
// unmatched programs under "Other".

import type { ConfigSchema } from '@/lib/widgets/types';

export interface ProgramGroup {
  label: string;
  match_patterns: string[]; // case-insensitive substrings; ANY match qualifies
}

export interface FinanceDashboardConfig {
  program_groups: ProgramGroup[];
  show_actual_payments_placeholder?: boolean;
  show_recipient_lists?: boolean;
}

// Desert Garden's default groupings — mirror the bespoke biz-officer
// report layout (Infant / Toddler-Primary / LE-UE / MYHS).
export const financeDashboardDefaults: FinanceDashboardConfig = {
  program_groups: [
    { label: 'Infant',                   match_patterns: ['infant'] },
    { label: 'Toddler / Primary',        match_patterns: ['toddler', 'primary', 'casa'] },
    { label: 'Lower / Upper Elementary', match_patterns: ['lower el', 'upper el', 'elementary', '04 lower', '05 upper'] },
    { label: 'MYHS',                     match_patterns: ['myhs', 'middle', 'high'] },
  ],
  show_actual_payments_placeholder: true,
  show_recipient_lists: true,
};

export const financeDashboardSchema: ConfigSchema = {
  fields: [],
};
