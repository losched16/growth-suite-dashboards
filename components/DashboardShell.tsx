import { DashboardNav } from './DashboardNav';
import type { SchoolDashboardRow } from '@/lib/dashboards/types';

interface Props {
  schoolName: string;
  locationId: string;
  dashboards: SchoolDashboardRow[];
  activeSlug: string | null;
  iconBySlug: Record<string, string>;
  // Shown for staff magic-link sessions (standalone schools) — renders
  // a sign-out control above the content.
  signedInAs?: string | null;
  // Appended to every dashboard nav link (e.g. '?chrome=classrooms') so a
  // scoped-nav mode survives navigation inside the iframe.
  linkSuffix?: string;
  // Hide the Parent Portal + Tools sections (teacher-facing scoped nav).
  minimal?: boolean;
  // Parent-Portal-only nav (?chrome=portal).
  portalOnly?: boolean;
  children: React.ReactNode;
}

export function DashboardShell({ schoolName, locationId, dashboards, activeSlug, iconBySlug, signedInAs, linkSuffix, minimal, portalOnly, children }: Props) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <DashboardNav
        schoolName={schoolName}
        locationId={locationId}
        dashboards={dashboards}
        activeSlug={activeSlug}
        iconBySlug={iconBySlug}
        linkSuffix={linkSuffix}
        minimal={minimal}
        portalOnly={portalOnly}
      />
      <main className="flex-1 min-w-0 p-6 overflow-x-auto">
        {signedInAs ? (
          <div className="mb-3 flex items-center justify-end gap-3 text-xs text-gray-500">
            <span>Signed in as {signedInAs}</span>
            <form action="/api/auth/staff/logout" method="POST">
              <button type="submit" className="rounded border border-gray-300 bg-white px-2 py-1 hover:bg-gray-50">
                Sign out
              </button>
            </form>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
