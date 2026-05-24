// Config for PortalFormsInbox — recent submissions feed from
// portal_form_submissions.

import type { ConfigSchema } from '@/lib/widgets/types';

export interface PortalFormsInboxConfig {
  limit: number;
  academic_year: string;
  category_filter: string;          // empty = all
  status_filter: string;            // 'all' | 'submitted' | 'pending_payment' | 'voided'
}

export const portalFormsInboxDefaults: PortalFormsInboxConfig = {
  limit: 25,
  academic_year: '2025-26',
  category_filter: '',
  status_filter: 'all',
};

export const portalFormsInboxSchema: ConfigSchema = {
  fields: [
    {
      type: 'number',
      key: 'limit',
      label: 'Max submissions to show',
      min: 1,
      max: 200,
    },
    {
      type: 'text',
      key: 'academic_year',
      label: 'Academic year',
      placeholder: '2025-26',
    },
    {
      type: 'select',
      key: 'status_filter',
      label: 'Status filter',
      options: [
        { value: 'all', label: 'All statuses' },
        { value: 'submitted', label: 'Submitted only' },
        { value: 'pending_payment', label: 'Pending payment' },
        { value: 'voided', label: 'Voided only' },
      ],
    },
    {
      type: 'text',
      key: 'category_filter',
      label: 'Category filter (optional)',
      placeholder: 'e.g. medical, permission, trip',
    },
  ],
};
