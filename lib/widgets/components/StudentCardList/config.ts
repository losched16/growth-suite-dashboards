import type { ConfigSchema } from '@/lib/widgets/types';

export interface StudentCardListConfig {
  family_id?: string;
}

export const studentCardListDefaults: StudentCardListConfig = {};

export const studentCardListSchema: ConfigSchema = { fields: [] };
