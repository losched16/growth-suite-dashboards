// /school/[locationId]/dashboard/[dashboardId] — school-facing dashboard
// layout editor. Reuses the operator DashboardConfigEditor component (same
// widget config UI); auth is enforced by the /school layout (school session),
// and the component scopes its query to this school's dashboards. allowDelete
// is off — schools customize widgets/columns/filters but can't delete a whole
// dashboard. Widget endpoints redirect back here via the Referer.

import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { query } from '@/lib/db';
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

  // Opened from a no-sidebar dashboard (?chrome=none): stay sidebar-less and
  // go back to that dashboard, not the full-shell dashboards list.
  const embedded = (await headers()).get('x-chrome') === 'none';
  let backHref = `/school/${locationId}`;
  let backLabel = 'Back to dashboards';
  if (embedded) {
    const { rows } = await query<{ dashboard_slug: string; display_name: string }>(
      `SELECT dashboard_slug, display_name FROM school_dashboards WHERE id = $1 AND school_id = $2`,
      [dashboardId, school.id],
    );
    if (rows[0]) {
      backHref = `/school/${locationId}/${rows[0].dashboard_slug}?chrome=none`;
      backLabel = `Back to ${rows[0].display_name}`;
    }
  }

  return (
    <DashboardConfigEditor
      schoolId={school.id}
      dashboardId={dashboardId}
      returnTo={`/school/${locationId}/dashboard/${dashboardId}${embedded ? '?chrome=none' : ''}`}
      backHref={backHref}
      backLabel={backLabel}
      allowDelete={false}
      msg={msg}
      err={err}
    />
  );
}
