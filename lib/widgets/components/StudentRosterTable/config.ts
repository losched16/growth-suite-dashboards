import type { ConfigSchema } from '@/lib/widgets/types';

export interface StudentRosterTableConfig {
  academic_year: string;          // empty = no enrollment join
  show_filters: boolean;          // (placeholder for future client-side filtering)
}

export const studentRosterTableDefaults: StudentRosterTableConfig = {
  academic_year: '',
  show_filters: true,
};

export const studentRosterTableSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'academic_year', label: 'Academic year', placeholder: '2026-27', help: 'Used to join current enrollment data per student. Leave blank for student list only.' },
  ],
};
