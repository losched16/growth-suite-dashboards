import type { ConfigSchema } from '@/lib/widgets/types';

export interface PaymentsOverviewConfig {
  // How many days of recent failures to show
  failure_window_days: number;
  // How many recent payments to list
  recent_limit: number;
}

export const paymentsOverviewDefaults: PaymentsOverviewConfig = {
  failure_window_days: 14,
  recent_limit: 10,
};

export const paymentsOverviewSchema: ConfigSchema = {
  fields: [
    { type: 'number', key: 'failure_window_days', label: 'Failure lookback (days)', min: 1, max: 90 },
    { type: 'number', key: 'recent_limit', label: 'Recent payments to show', min: 1, max: 50 },
  ],
};
