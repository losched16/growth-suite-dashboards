import { notFound, redirect } from 'next/navigation';
import { headers, cookies } from 'next/headers';
import { loadSchoolByLocationId, listSchoolDashboards } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { DashboardShell } from '@/components/DashboardShell';
import { dashboardRegistry } from '@/lib/dashboards/registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// School-facing layout. Resolves the school by ghl_location_id, loads the
// list of enabled dashboards, and renders the shell.
//
// Embed mode (`?chrome=none`): iframe embeds typically show one dashboard
// at a time inside GHL; the side nav listing every dashboard would expose
// dashboards the school may want restricted (e.g. Tuition for non-admin
// staff). When the proxy detects `chrome=none` it propagates an
// `x-chrome: none` request header, and we render just `{children}` —
// no sidebar, no school header. Operators copy a separate embed URL for
// each dashboard they want to show.
//
// Per brief §10.3, the CSP `frame-ancestors` header is set in
// next.config.ts so GHL can iframe-embed us.

export default async function SchoolLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Bare-embed mode: skip the shell entirely. The proxy sets `x-chrome:
  // none` when the operator passes `?chrome=none`, and forces it on for
  // the GHL-native Payments hub (which brings its own header).
  const reqHeaders = await headers();
  if (reqHeaders.get('x-chrome') === 'none') {
    return <div className="min-h-screen bg-gray-50">{children}</div>;
  }

  // Standalone schools: the full-shell experience requires a signed-in
  // staff session (or an operator session) — anonymous hits bounce to
  // the magic-link page. Legacy schools keep today's open-URL behavior.
  const ck = await cookies();
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (school.require_staff_login) {
    const operatorSession = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
    const authorized = operatorSession || (schoolSession && schoolSession.school_id === school.id);
    if (!authorized) redirect('/staff');
  }
  // Show the sign-out control only for staff magic-link sessions.
  const signedInAs = schoolSession?.via === 'staff' && schoolSession.school_id === school.id
    ? schoolSession.user_name || schoolSession.user_email
    : null;

  const dashboards = await listSchoolDashboards(school.id, { onlyEnabled: true });

  // Build a slug → icon map from the static registry so the nav knows
  // which icon to show for each dashboard.
  const iconBySlug: Record<string, string> = {};
  for (const d of dashboards) {
    const def = dashboardRegistry[d.dashboard_slug];
    if (def) iconBySlug[d.dashboard_slug] = def.icon;
  }

  return (
    <DashboardShell
      schoolName={school.name}
      locationId={school.ghl_location_id}
      dashboards={dashboards}
      activeSlug={null /* pages override the highlight via the URL */}
      iconBySlug={iconBySlug}
      signedInAs={signedInAs}
    >
      {children}
    </DashboardShell>
  );
}
