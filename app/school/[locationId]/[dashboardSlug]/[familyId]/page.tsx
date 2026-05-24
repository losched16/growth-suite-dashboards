// Drill-down route. Renders the dashboard's detail_layout (from
// dashboardRegistry) with `family_id` injected into each widget config.
// Per brief §11.3: each widget in detail_layout is scoped to one family.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadSchoolByLocationId, getSchoolDashboard } from '@/lib/dashboards/loader';
import { getDashboard } from '@/lib/dashboards/registry';
import { WidgetRenderer } from '@/components/WidgetRenderer';
import type { SchoolContext, WidgetInstance } from '@/lib/widgets/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Params = Promise<{
  locationId: string;
  dashboardSlug: string;
  familyId: string;
}>;

export default async function DashboardDetailPage({ params }: { params: Params }) {
  const { locationId, dashboardSlug, familyId } = await params;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const schoolDashboard = await getSchoolDashboard(school.id, dashboardSlug);
  if (!schoolDashboard || !schoolDashboard.is_enabled) notFound();

  const def = getDashboard(dashboardSlug);
  const detailLayout: WidgetInstance[] = def?.detail_layout ?? [];

  if (detailLayout.length === 0) {
    return (
      <div>
        <BackLink locationId={locationId} dashboardSlug={dashboardSlug} dashboardName={schoolDashboard.display_name} />
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          This dashboard has no detail view configured.
        </div>
      </div>
    );
  }

  // Inject family_id into each widget's config for the detail render.
  const scoped: WidgetInstance[] = detailLayout.map((inst) => ({
    ...inst,
    config: { ...(inst.config as object), family_id: familyId },
  }));

  const ctx: SchoolContext = {
    schoolId: school.id,
    schoolName: school.name,
    locationId: school.ghl_location_id,
  };

  return (
    <div className="space-y-4">
      <div>
        <BackLink locationId={locationId} dashboardSlug={dashboardSlug} dashboardName={schoolDashboard.display_name} />
      </div>
      <div className="space-y-4">
        {scoped.map((instance) => (
          <WidgetRenderer key={instance.instance_id} school={ctx} instance={instance} />
        ))}
      </div>
    </div>
  );
}

function BackLink({
  locationId,
  dashboardSlug,
  dashboardName,
}: {
  locationId: string;
  dashboardSlug: string;
  dashboardName: string;
}) {
  return (
    <Link
      href={`/school/${locationId}/${dashboardSlug}`}
      className="text-xs text-emerald-700 hover:underline"
    >
      ← {dashboardName}
    </Link>
  );
}
