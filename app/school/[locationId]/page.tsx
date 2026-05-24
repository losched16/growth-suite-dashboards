import { notFound, redirect } from 'next/navigation';
import { loadSchoolByLocationId, listSchoolDashboards } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

// Default landing — redirect to the first enabled dashboard.
export default async function SchoolHome({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const dashboards = await listSchoolDashboards(school.id, { onlyEnabled: true });
  if (dashboards.length === 0) {
    return (
      <div className="text-sm text-gray-500">
        No dashboards configured for this school yet. The operator can provision them in the admin UI.
      </div>
    );
  }
  redirect(`/school/${locationId}/${dashboards[0].dashboard_slug}`);
}
