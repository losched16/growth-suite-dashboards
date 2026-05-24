import type { ConfigSchema } from '@/lib/widgets/types';

export interface EnrollmentTargetsTableConfig {
  academic_year: string;
  // 'enrollment' (default) | 'admissions' — the latter shows pipeline counts too.
  mode: string;
}

export const enrollmentTargetsTableDefaults: EnrollmentTargetsTableConfig = {
  academic_year: '2026-27',
  mode: 'enrollment',
};

export const enrollmentTargetsTableSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'academic_year', label: 'Academic year', placeholder: '2026-27' },
    {
      type: 'select',
      key: 'mode',
      label: 'Mode',
      options: [
        { value: 'enrollment', label: 'Enrollment vs target' },
        { value: 'admissions', label: 'Admissions funnel counts' },
      ],
    },
  ],
};
