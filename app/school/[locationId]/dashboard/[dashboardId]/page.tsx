// /school/[locationId]/dashboard/[dashboardId] — school-facing dashboard
// layout editor. Reuses the operator DashboardConfigEditor component (same
// widget config UI); auth is enforced by the /school layout (school session),
// and the component scopes its query to this school's dashboards. allowDelete
// is off — schools customize widgets/columns/filters but can't delete a whole
// dashboard. Widget endpoints redirect back here via the Referer.

import { notFound } from 'next/navigation';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { DashboardConfigEditor } from '@/app/admin/[schoolId]/dashboard/[dashboardId]/page';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; dashboardId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function SchoolDashboardEditPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId, dashboardId } = await params;
  const { msg, err } = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  return (
    <DashboardConfigEditor
      schoolId={school.id}
      dashboardId={dashboardId}
      returnTo={`/school/${locationId}/dashboard/${dashboardId}`}
      backHref={`/school/${locationId}`}
      backLabel="Back to dashboards"
      allowDelete={false}
      msg={msg}
      err={err}
    />
  );
}
