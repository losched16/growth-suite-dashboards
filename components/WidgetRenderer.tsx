// Server component. Looks up a widget by id, runs its dataFetcher, renders
// its Component. Wraps each widget in a uniform card with error handling.
//
// Per brief §11.2: cache fetcher results for 60s in memory keyed by
// (school_id, widget_id, config_hash).

import { getWidget } from '@/lib/widgets/registry';
import { hashConfig, memo } from '@/lib/widgets/cache';
import type { SchoolContext, WidgetInstance, WidgetSearchParams } from '@/lib/widgets/types';

interface Props {
  school: SchoolContext;
  instance: WidgetInstance;
  // Page passes its searchParams in. Widgets that opt-in read filter state
  // from here. Default empty so non-opting widgets ignore.
  searchParams?: WidgetSearchParams;
}

export async function WidgetRenderer({ school, instance, searchParams }: Props) {
  const definition = getWidget(instance.widget_id);
  if (!definition) {
    return (
      <WidgetShell title="Unknown widget" subtitle={instance.widget_id} error>
        <div className="text-sm text-red-700">
          No widget registered with id <code>{instance.widget_id}</code>.
        </div>
      </WidgetShell>
    );
  }

  // Cache key includes searchParams only if the widget says it cares.
  const spForKey = definition.searchParamsAffectFetch && searchParams
    ? hashConfig(searchParams)
    : '';
  const cacheKey = `${school.schoolId}|${instance.widget_id}|${hashConfig(instance.config)}|${spForKey}`;
  let data: unknown = null;
  let error: string | null = null;

  try {
    data = await memo(cacheKey, () =>
      definition.dataFetcher(school, instance.config, searchParams),
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (error) {
    return (
      <WidgetShell title={definition.display_name} subtitle={definition.description} error>
        <div className="text-sm text-red-700 whitespace-pre-wrap">{error}</div>
      </WidgetShell>
    );
  }

  const Component = definition.Component as unknown as React.ComponentType<{
    school: SchoolContext;
    config: unknown;
    data: unknown;
    searchParams?: WidgetSearchParams;
  }>;

  return (
    <Component school={school} config={instance.config} data={data} searchParams={searchParams} />
  );
}

function WidgetShell({
  title,
  subtitle,
  children,
  error,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div className={`rounded-lg border ${error ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'} p-4`}>
      <div className="mb-2">
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        {subtitle ? <div className="text-xs text-gray-500">{subtitle}</div> : null}
      </div>
      {children}
    </div>
  );
}
