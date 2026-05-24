import type { ConfigSchema } from '@/lib/widgets/types';
import type { FamilyFilter } from '@/lib/widgets/family-source';

export interface FormCompletionGridConfig {
  family_filter: FamilyFilter;
  // Importer field_keys for the DATE fields that mark form completion.
  form_field_keys: string[];
  // Show only families with N or more incomplete forms (0 = show all).
  min_incomplete: number;
}

export const formCompletionGridDefaults: FormCompletionGridConfig = {
  family_filter: { kind: 'tag', value: 'enrolled - 26/27' },
  form_field_keys: [],
  min_incomplete: 0,
};

export const formCompletionGridSchema: ConfigSchema = {
  fields: [
    {
      type: 'field_registry_multi',
      key: 'form_field_keys',
      label: 'Forms to track',
      filter: { field_type: 'DATE' },
      help: 'Pick the DATE custom fields that mark form completion (one per form).',
    },
    {
      type: 'number',
      key: 'min_incomplete',
      label: 'Show only families with at least N incomplete forms',
      min: 0,
      max: 99,
    },
  ],
};
