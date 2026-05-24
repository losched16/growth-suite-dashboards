import type { ConfigSchema } from '@/lib/widgets/types';

export interface AdmissionsFunnelStagesConfig {
  academic_year: string;
  // Optional: filter to one grade level (matches classroom.grade_level).
  grade_level?: string;
}

export const admissionsFunnelStagesDefaults: AdmissionsFunnelStagesConfig = {
  academic_year: '2026-27',
};

export const admissionsFunnelStagesSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'academic_year', label: 'Academic year', placeholder: '2026-27' },
    { type: 'text', key: 'grade_level', label: 'Grade filter (optional)', placeholder: 'e.g. K, 1st, primary' },
  ],
};
