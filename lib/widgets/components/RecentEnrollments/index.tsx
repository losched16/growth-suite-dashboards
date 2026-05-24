import Link from 'next/link';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import { recentEnrollmentsDefaults, recentEnrollmentsSchema, type RecentEnrollmentsConfig } from './config';
import { fetcher, type RecentEnrollmentsData } from './fetcher';

const STATUS_PILL: Record<string, string> = {
  enrolled: 'bg-emerald-100 text-emerald-800',
  accepted: 'bg-blue-100 text-blue-800',
  application_submitted: 'bg-violet-100 text-violet-800',
  tour_scheduled: 'bg-cyan-100 text-cyan-800',
  inquiry: 'bg-amber-100 text-amber-800',
  waitlisted: 'bg-orange-100 text-orange-800',
  withdrawn: 'bg-rose-100 text-rose-800',
  declined: 'bg-zinc-200 text-zinc-700',
};

function RecentEnrollmentsComponent({
  school,
  data,
}: {
  school: SchoolContext;
  data: RecentEnrollmentsData;
}) {
  if (data.items.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No enrollments for {data.academic_year || '(no year set)'}.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Recent enrollments · {data.academic_year}</h3>
        <div className="text-xs text-gray-500">{data.items.length} of {data.total_seen}</div>
      </div>
      <ul className="divide-y divide-gray-100">
        {data.items.map((it, i) => (
          <li key={`${it.family_id}-${it.student_name}-${i}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{it.student_name}</div>
              <div className="text-xs text-gray-500 truncate">
                <Link href={`/school/${school.locationId}/family-hub/${it.family_id}`} className="text-emerald-700 hover:underline">
                  {it.family_name || '(unnamed family)'}
                </Link>
                {it.classroom_name ? <> · {it.classroom_name}</> : null}
              </div>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[it.status] ?? 'bg-gray-100 text-gray-700'}`}>
              {it.status.replace(/_/g, ' ')}
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-gray-100 px-4 py-2 text-[10px] text-gray-400">
        {data.approximation_note}
      </div>
    </div>
  );
}

export const RecentEnrollments: WidgetDefinition<RecentEnrollmentsConfig, RecentEnrollmentsData> = {
  id: 'recent_enrollments',
  display_name: 'Recent Enrollments',
  description: 'Most recent enrollments across the school for an academic year.',
  category: 'enrollment',
  default_config: recentEnrollmentsDefaults,
  config_schema: recentEnrollmentsSchema,
  default_size: { w: 12, h: 5 },
  Component: RecentEnrollmentsComponent,
  dataFetcher: fetcher,
};
