import { DashboardNav } from './DashboardNav';
import type { SchoolDashboardRow } from '@/lib/dashboards/types';

interface Props {
  schoolName: string;
  locationId: string;
  dashboards: SchoolDashboardRow[];
  activeSlug: string | null;
  iconBySlug: Record<string, string>;
  children: React.ReactNode;
}

export function DashboardShell({ schoolName, locationId, dashboards, activeSlug, iconBySlug, children }: Props) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <DashboardNav
        schoolName={schoolName}
        locationId={locationId}
        dashboards={dashboards}
        activeSlug={activeSlug}
        iconBySlug={iconBySlug}
      />
      <main className="flex-1 min-w-0 p-6 overflow-x-auto">
        {children}
      </main>
    </div>
  );
}
