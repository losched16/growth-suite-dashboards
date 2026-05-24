import type { ConfigSchema } from '@/lib/widgets/types';

export interface FinancialAidQueueConfig {
  default_academic_year: string;
  default_recommended_award_floor: number;     // $ floor for sanity-check
  default_recommended_award_ceiling: number;   // $ ceiling
}

export const financialAidQueueDefaults: FinancialAidQueueConfig = {
  default_academic_year: '2025-26',
  default_recommended_award_floor: 0,
  default_recommended_award_ceiling: 50000,
};

export const financialAidQueueSchema: ConfigSchema = {
  fields: [
    {
      type: 'text',
      key: 'default_academic_year',
      label: 'Default academic year',
      help: 'Pre-fills the year filter. Format: YYYY-YY (e.g. 2025-26).',
    },
    {
      type: 'number',
      key: 'default_recommended_award_floor',
      label: 'Min recommended award ($)',
      min: 0,
    },
    {
      type: 'number',
      key: 'default_recommended_award_ceiling',
      label: 'Max recommended award ($)',
      min: 0,
    },
  ],
};
