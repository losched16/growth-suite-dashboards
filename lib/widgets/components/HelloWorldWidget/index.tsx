import type { WidgetDefinition } from '@/lib/widgets/types';
import { helloWorldDefaults, helloWorldSchema, type HelloWorldConfig } from './config';
import { fetcher, type HelloWorldData } from './fetcher';

function HelloWorldComponent({
  data,
}: {
  data: HelloWorldData;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-2xl font-semibold text-gray-900">{data.message}</div>
      <div className="mt-1 text-xs text-gray-500">
        Fetched {new Date(data.fetched_at).toLocaleTimeString()}
      </div>
    </div>
  );
}

export const HelloWorldWidget: WidgetDefinition<HelloWorldConfig, HelloWorldData> = {
  id: 'hello_world',
  display_name: 'Hello World',
  description: 'Test widget for verifying the framework. Remove before launch.',
  category: 'system',
  default_config: helloWorldDefaults,
  config_schema: helloWorldSchema,
  default_size: { w: 6, h: 2 },
  Component: HelloWorldComponent,
  dataFetcher: fetcher,
};
