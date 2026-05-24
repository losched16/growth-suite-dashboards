import type { SchoolContext } from '@/lib/widgets/types';
import type { HelloWorldConfig } from './config';

export interface HelloWorldData {
  message: string;
  fetched_at: string;
}

export async function fetcher(school: SchoolContext, config: HelloWorldConfig): Promise<HelloWorldData> {
  const who = config.show_school_name ? school.schoolName : 'world';
  return {
    message: `${config.greeting}, ${who}!`,
    fetched_at: new Date().toISOString(),
  };
}
