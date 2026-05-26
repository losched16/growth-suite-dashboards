import { notFound } from 'next/navigation';
import {
  loadSchoolByLocationId,
  getSchoolDashboard,
} from '@/lib/dashboards/loader';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';

// Classroom + program hubs get a top tab bar (Roster / Submit
// Request / My Requests). Other dashboards (Family Hub, Tuition,
// etc.) render plain. Match the slug pattern that the provisioner
// uses for the per-classroom dashboards.
function isClassroomHub(slug: string): boolean {
  return /^(classroom-|program-)/.test(slug);
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Params = Promise<{ locationId: string; dashboardSlug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { locationId, dashboardSlug } = await params;
  const rawSearchParams = await searchParams;
  const sp: WidgetSearchParams = {};
  for (const [k, v] of Object.entries(rawSearchParams)) {
    if (v === undefined) continue;
    sp[k] = Array.isArray(v) ? v[0] : v;
  }

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const dashboard = await getSchoolDashboard(school.id, dashboardSlug);
  if (!dashboard || !dashboard.is_enabled) notFound();

  const ctx: SchoolContext = {
    schoolId: school.id,
    schoolName: school.name,
    locationId: school.ghl_location_id,
  };

  const showClassroomNav = isClassroomHub(dashboardSlug);

  return (
    <div className="space-y-4">
      {showClassroomNav ? (
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={dashboardSlug}
          classroomLabel={dashboard.display_name}
          active="roster"
        />
      ) : null}

      <header>
        <h1 className="text-xl font-semibold text-gray-900">{dashboard.display_name}</h1>
        {dashboard.description ? (
          <p className="text-sm text-gray-500 mt-0.5">{dashboard.description}</p>
        ) : null}
      </header>

      <div className="space-y-4">
        {dashboard.layout.length === 0 ? (
          <div className="rounded-md border border-gray-200 bg-white p-6 text-sm text-gray-500">
            No widgets on this dashboard.
          </div>
        ) : (
          dashboard.layout.map((instance) => (
            <WidgetRenderer
              key={instance.instance_id}
              school={ctx}
              instance={instance}
              searchParams={sp}
            />
          ))
        )}
      </div>
    </div>
  );
}
