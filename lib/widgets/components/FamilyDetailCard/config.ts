import type { ConfigSchema } from '@/lib/widgets/types';

export interface FamilyDetailCardConfig {
  // Injected by the drill-down route. The widget renders a config-error
  // message if missing.
  family_id?: string;
}

export const familyDetailCardDefaults: FamilyDetailCardConfig = {};

export const familyDetailCardSchema: ConfigSchema = {
  fields: [
    // Hidden in the operator UI — populated by the detail route at render time.
  ],
};
