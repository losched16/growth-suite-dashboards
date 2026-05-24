// Config for PortalFormsCompletionGrid — driven by native
// portal_form_submissions, not legacy GHL date-field tracking.
//
// Operator picks: which categories of forms to show as columns,
// and which academic year to filter on.

import type { ConfigSchema } from '@/lib/widgets/types';

export interface PortalFormsCompletionGridConfig {
  categories: string[];           // empty = all categories
  academic_year: string;
  only_active: boolean;           // skip is_active=false definitions
  status_filter: 'enrolled' | 'all';
}

export const portalFormsCompletionGridDefaults: PortalFormsCompletionGridConfig = {
  categories: [],
  academic_year: '2025-26',
  only_active: true,
  status_filter: 'enrolled',
};

export const portalFormsCompletionGridSchema: ConfigSchema = {
  fields: [
    {
      type: 'text',
      key: 'academic_year',
      label: 'Academic year',
      placeholder: '2025-26',
    },
    {
      type: 'select',
      key: 'status_filter',
      label: 'Students to include',
      options: [
        { value: 'enrolled', label: 'Currently enrolled only' },
        { value: 'all', label: 'All active students' },
      ],
    },
    {
      type: 'boolean',
      key: 'only_active',
      label: 'Only show active forms',
    },
  ],
};
