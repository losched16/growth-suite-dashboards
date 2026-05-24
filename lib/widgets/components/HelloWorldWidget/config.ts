import type { ConfigSchema } from '@/lib/widgets/types';

export interface HelloWorldConfig {
  greeting: string;
  show_school_name: boolean;
}

export const helloWorldDefaults: HelloWorldConfig = {
  greeting: 'Hello',
  show_school_name: true,
};

export const helloWorldSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'greeting', label: 'Greeting', placeholder: 'Hello' },
    { type: 'boolean', key: 'show_school_name', label: 'Show school name' },
  ],
};
