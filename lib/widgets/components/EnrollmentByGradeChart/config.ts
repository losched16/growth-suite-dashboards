import type { ConfigSchema } from '@/lib/widgets/types';

export interface EnrollmentByGradeChartConfig {
  academic_year: string;
}

export const enrollmentByGradeChartDefaults: EnrollmentByGradeChartConfig = {
  academic_year: '2026-27',
};

export const enrollmentByGradeChartSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'academic_year', label: 'Academic year', placeholder: '2026-27' },
  ],
};
