import type { ConfigSchema } from '@/lib/widgets/types';

export interface RecentEnrollmentsConfig {
  academic_year: string;
  limit: number;
}

export const recentEnrollmentsDefaults: RecentEnrollmentsConfig = {
  academic_year: '2026-27',
  limit: 15,
};

export const recentEnrollmentsSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'academic_year', label: 'Academic year', placeholder: '2026-27' },
    { type: 'number', key: 'limit', label: 'How many to show', min: 1, max: 100 },
  ],
};
