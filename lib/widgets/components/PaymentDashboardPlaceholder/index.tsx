import { CreditCard } from 'lucide-react';
import type { WidgetDefinition } from '@/lib/widgets/types';
import type { ConfigSchema } from '@/lib/widgets/types';

interface Config {}
interface Data {}

const schema: ConfigSchema = { fields: [] };

function Component() {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gradient-to-br from-emerald-50 to-white p-8 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 mb-3">
        <CreditCard className="h-6 w-6 text-emerald-700" />
      </div>
      <h3 className="text-base font-semibold text-gray-900">Tuition & Payments — coming soon</h3>
      <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">
        Payment plans, family billing, and tuition status will appear here once
        Smart Payments is consolidated into Growth Suite.
      </p>
    </div>
  );
}

export const PaymentDashboardPlaceholder: WidgetDefinition<Config, Data> = {
  id: 'payment_dashboard_placeholder',
  display_name: 'Payment Dashboard (placeholder)',
  description: '"Coming soon" card for Tuition & Payments. Replaced when Smart Payments integrates.',
  category: 'billing',
  default_config: {},
  config_schema: schema,
  default_size: { w: 12, h: 4 },
  Component,
  dataFetcher: async () => ({}),
};
