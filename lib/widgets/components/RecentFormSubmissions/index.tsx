import type { WidgetDefinition } from '@/lib/widgets/types';
import { recentFormSubmissionsDefaults, recentFormSubmissionsSchema, type RecentFormSubmissionsConfig } from './config';
import { fetcher, type RecentFormSubmissionsData } from './fetcher';

function fmtDateTime(s: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function RecentFormSubmissionsComponent({ data }: { data: RecentFormSubmissionsData }) {
  if (data.forms_tracked === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Configure this widget with at least one form field to track.
      </div>
    );
  }
  if (data.submissions.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No submissions yet across the {data.forms_tracked} tracked form{data.forms_tracked === 1 ? '' : 's'}.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Recent submissions</h3>
        <div className="text-xs text-gray-500">
          {data.submissions.length} of {data.total_seen} shown · {data.forms_tracked} forms tracked
        </div>
      </div>
      <ul className="divide-y divide-gray-100">
        {data.submissions.map((s, i) => (
          <li key={`${s.contact_id}-${s.form_field_key}-${i}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{s.family_label}</div>
              <div className="text-xs text-gray-600 truncate">{s.form_display_name}</div>
            </div>
            <div className="text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(s.completed_at)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const RecentFormSubmissions: WidgetDefinition<RecentFormSubmissionsConfig, RecentFormSubmissionsData> = {
  id: 'recent_form_submissions',
  display_name: 'Recent Form Submissions',
  description: 'Most recent form completions across the school.',
  category: 'documents',
  default_config: recentFormSubmissionsDefaults,
  config_schema: recentFormSubmissionsSchema,
  default_size: { w: 12, h: 5 },
  Component: RecentFormSubmissionsComponent,
  dataFetcher: fetcher,
};
