import { BarChart3 } from 'lucide-react';
import type { WidgetDefinition } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';

interface Config {}
interface Data {}

const schema: ConfigSchema = { fields: [] };

function Component() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gradient-to-br from-indigo-50 to-white p-8 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 mb-3">
        <BarChart3 className="h-6 w-6 text-indigo-700" />
      </div>
      <h3 className="text-base font-semibold text-gray-900">Marketing analytics — coming soon</h3>
      <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">
        Lead source attribution, campaign performance, and inquiry funnel
        analytics will appear here once marketing data is wired into Growth Suite.
      </p>
    </div>
  );
}

export const MarketingDashboardPlaceholder: WidgetDefinition<Config, Data> = {
  id: 'marketing_dashboard_placeholder',
  display_name: 'Marketing Dashboard (placeholder)',
  description: '"Coming soon" card for Marketing analytics. Replaced when lead source data is integrated.',
  category: 'marketing',
  default_config: {},
  config_schema: schema,
  default_size: { w: 12, h: 4 },
  Component,
  dataFetcher: async () => ({}),
};
