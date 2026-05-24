import type { ConfigSchema } from '@/lib/widgets/types';

export interface AttendanceDashboardConfig {
  // IANA timezone (school's). For the MVP we hardcode DG's; will read
  // from schools.timezone when we add the column.
  timezone: string;
  // Default date filter mode on first load.
  default_view: 'today' | 'date_range';
  // Per-classroom dashboards set this so attendance pre-narrows. URL
  // `?classroom=...` still wins when present.
  default_classroom_filter?: string;
  // Program-scoped dashboards (Upper El, MYHS) — pre-narrow to one
  // program. Filters against student.metadata.program.
  default_program_filter?: string;
}

export const attendanceDashboardDefaults: AttendanceDashboardConfig = {
  timezone: 'America/Phoenix',
  default_view: 'today',
};

export const attendanceDashboardSchema: ConfigSchema = {
  fields: [
    {
      type: 'text',
      key: 'timezone',
      label: 'Timezone (IANA)',
      help: 'e.g. America/Phoenix, America/Chicago. Drives the "today" window.',
    },
    {
      type: 'select',
      key: 'default_view',
      label: 'Default view',
      options: [
        { value: 'today', label: 'Today' },
        { value: 'date_range', label: 'Date range' },
      ],
    },
  ],
};
