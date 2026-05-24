import type { ConfigSchema } from '@/lib/widgets/types';

export interface StudentDocumentsBrowserConfig {
  page_size: number;
}

export const studentDocumentsBrowserDefaults: StudentDocumentsBrowserConfig = {
  page_size: 100,
};

export const studentDocumentsBrowserSchema: ConfigSchema = {
  fields: [
    { type: 'number', key: 'page_size', label: 'Rows per page', min: 25, max: 500 },
  ],
};
