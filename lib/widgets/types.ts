// Widget framework types. The whole dashboard platform hangs off these.

import type { ComponentType } from 'react';

export type WidgetCategory =
  | 'documents'
  | 'enrollment'
  | 'admissions'
  | 'family'
  | 'student'
  | 'billing'
  | 'marketing'
  | 'system';

// Simple JSON-schema-lite for the operator UI to render config fields.
// Each entry says how to render one config knob.
export type ConfigField =
  | {
      type: 'text';
      key: string;
      label: string;
      required?: boolean;
      placeholder?: string;
      help?: string;
    }
  | {
      type: 'number';
      key: string;
      label: string;
      min?: number;
      max?: number;
      help?: string;
    }
  | {
      type: 'boolean';
      key: string;
      label: string;
      help?: string;
    }
  | {
      type: 'select';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      help?: string;
    }
  | {
      // Lets the operator pick GHL custom field keys from this school's
      // ghl_field_registry. Filtered by GHL data type.
      type: 'field_registry_multi';
      key: string;
      label: string;
      filter: { field_type?: string; folder_name?: string };
      help?: string;
    };

export interface ConfigSchema {
  fields: ConfigField[];
}

export interface SchoolContext {
  schoolId: string;
  schoolName: string;
  locationId: string;
}

// What we render on a school's dashboard. Stored in school_dashboards.layout
// as a JSON array of these.
export interface WidgetInstance<TConfig = unknown> {
  instance_id: string;
  widget_id: string;
  config: TConfig;
  position: { x: number; y: number; w: number; h: number };
}

// The static definition of a widget. Each widget exports one of these.
// Component is a Server Component by default (can be 'use client' if needed
// for interactivity). dataFetcher runs server-side and yields the data the
// component renders.
// URL search params passed down to widgets that opt into them (e.g.
// filterable tables that read filter state from the URL). Plain
// string-valued bag — Next 16's searchParams shape but flattened.
export type WidgetSearchParams = Record<string, string | undefined>;

export interface WidgetDefinition<TConfig = unknown, TData = unknown> {
  id: string;
  display_name: string;
  description: string;
  category: WidgetCategory;
  default_config: TConfig;
  config_schema: ConfigSchema;
  default_size: { w: number; h: number };
  Component: ComponentType<{
    school: SchoolContext;
    config: TConfig;
    data: TData;
    searchParams?: WidgetSearchParams;
  }>;
  // Returning a `null`-ish value is allowed and treated as "no data".
  dataFetcher: (
    school: SchoolContext,
    config: TConfig,
    searchParams?: WidgetSearchParams,
  ) => Promise<TData>;
  // If true, the cache key includes the searchParams. Defaults to false:
  // widgets that don't read searchParams skip this so caching works.
  searchParamsAffectFetch?: boolean;
}
