import type { ConfigSchema } from '@/lib/widgets/types';
import type { FamilyFilter } from '@/lib/widgets/family-source';

export interface RecentFormSubmissionsConfig {
  family_filter: FamilyFilter;
  form_field_keys: string[];
  limit: number;
}

export const recentFormSubmissionsDefaults: RecentFormSubmissionsConfig = {
  family_filter: { kind: 'tag', value: 'enrolled - 26/27' },
  form_field_keys: [],
  limit: 20,
};

export const recentFormSubmissionsSchema: ConfigSchema = {
  fields: [
    {
      type: 'field_registry_multi',
      key: 'form_field_keys',
      label: 'Forms to track',
      filter: { field_type: 'DATE' },
    },
    {
      type: 'number',
      key: 'limit',
      label: 'How many recent submissions to show',
      min: 1,
      max: 200,
    },
  ],
};
