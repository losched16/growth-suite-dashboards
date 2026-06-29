import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { PORTAL_NAV } from '@/lib/portal-nav';
import { listSchoolDashboards } from '@/lib/dashboards/loader';
import { dashboardRegistry } from '@/lib/dashboards/registry';
import { deriveEmbedToken } from '@/lib/auth/embed';
import { loadSchoolFieldSchema } from '@/lib/sync/schema-loader';
import { EmbedUrlsSection } from './_embed-urls';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function SchoolAdmin({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { schoolId } = await params;
  const { msg, err } = await searchParams;

  const { rows: schoolRows } = await query<{
    id: string; name: string; ghl_location_id: string;
  }>('SELECT id, name, ghl_location_id FROM schools WHERE id = $1', [schoolId]);
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  const dashboards = await listSchoolDashboards(school.id);
  const allSlugs = new Set(Object.keys(dashboardRegistry));
  for (const d of dashboards) allSlugs.delete(d.dashboard_slug);
  const provisionableSlugs = [...allSlugs];

  // Row counts in family-graph for this school. Used by the "Sync from
  // GHL" panel so the operator can see if data is populated.
  const { rows: countRows } = await query<{
    families: string; parents: string; students: string;
    enrollments: string; classrooms: string;
  }>(
    `SELECT
       (SELECT count(*) FROM families WHERE school_id = $1) as families,
       (SELECT count(*) FROM parents WHERE school_id = $1) as parents,
       (SELECT count(*) FROM students WHERE school_id = $1) as students,
       (SELECT count(*) FROM enrollments WHERE school_id = $1) as enrollments,
       (SELECT count(*) FROM classrooms WHERE school_id = $1) as classrooms`,
    [schoolId],
  );
  const fgCounts = countRows[0];

  const fieldSchema = await loadSchoolFieldSchema(schoolId);

  // Parent 2 promotion status (how many P2s exist; how many have their own GHL contact yet)
  const { rows: p2Rows } = await query<{
    total_with_p2: string;
    p2_with_email: string;
    p2_promoted: string;
    p2_promotable: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE p2.id IS NOT NULL)::text AS total_with_p2,
       count(*) FILTER (WHERE p2.id IS NOT NULL AND p2.email IS NOT NULL AND p2.email <> '')::text AS p2_with_email,
       count(*) FILTER (WHERE p2.id IS NOT NULL AND p2.ghl_contact_id IS NOT NULL)::text AS p2_promoted,
       count(*) FILTER (WHERE p2.id IS NOT NULL AND p2.email IS NOT NULL AND p2.email <> '' AND p2.ghl_contact_id IS NULL)::text AS p2_promotable
     FROM families f
     LEFT JOIN LATERAL (
       SELECT id, email, ghl_contact_id FROM parents
       WHERE family_id = f.id AND is_primary = false AND status = 'active'
       ORDER BY created_at LIMIT 1
     ) p2 ON true
     WHERE f.school_id = $1`,
    [schoolId],
  );
  const p2Counts = p2Rows[0];

  // Parent-upload summary for the section link.
  const { rows: uploadCountRows } = await query<{
    total: string;
    pending_sync: string;
    failed_sync: string;
    unacknowledged: string;
  }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE ghl_synced_at IS NULL AND (ghl_sync_error IS NULL OR ghl_sync_error = ''))::text AS pending_sync,
       count(*) FILTER (WHERE ghl_sync_error IS NOT NULL AND ghl_sync_error <> '')::text AS failed_sync,
       count(*) FILTER (WHERE acknowledged_at IS NULL)::text AS unacknowledged
     FROM parent_uploads WHERE school_id = $1`,
    [schoolId],
  );
  const uploadCounts = uploadCountRows[0];

  // Recent sync activity (last 20 events) — manual + cron combined.
  const { rows: syncLog } = await query<{
    fetched_at: Date;
    widget_id: string;
    duration_ms: number | null;
    error: string | null;
  }>(
    `SELECT fetched_at, widget_id, duration_ms, error
     FROM widget_fetch_log
     WHERE school_id = $1 AND dashboard_slug = '_sync'
     ORDER BY fetched_at DESC
     LIMIT 20`,
    [schoolId],
  );

  // Parent portal: branding row + forms list
  const { rows: brandingRows } = await query<{
    display_name: string | null;
    logo_url: string | null;
    primary_color: string | null;
    primary_color_soft: string | null;
    primary_color_fg: string | null;
    support_email: string | null;
    support_phone: string | null;
    footer_html: string | null;
    portal_hidden_nav: string[] | null;
  }>(
    `SELECT display_name, logo_url, primary_color, primary_color_soft, primary_color_fg,
            support_email, support_phone, footer_html, portal_hidden_nav
     FROM school_branding WHERE school_id = $1`,
    [schoolId],
  );
  const branding = brandingRows[0] ?? null;
  const hiddenNav = new Set(branding?.portal_hidden_nav ?? []);

  const { rows: portalForms } = await query<{
    id: string; display_name: string; description: string | null;
    completion_field_key: string; fill_out_url: string | null;
    per_student: boolean; position: number; is_active: boolean;
  }>(
    `SELECT id, display_name, description, completion_field_key, fill_out_url,
            per_student, position, is_active
     FROM school_forms WHERE school_id = $1 ORDER BY position, display_name`,
    [schoolId],
  );

  // Build embed URLs for every provisioned dashboard. Token is the same per
  // school (deterministic HMAC); only the path slug changes.
  let embedRows: { slug: string; display_name: string; is_enabled: boolean; url: string; urlWithNav: string }[] = [];
  let embedBaseHint = '';
  let embedTokenError: string | null = null;
  // Also used by the per-row "preview ↗" link below so it works in
  // production (the proxy needs an embed_token or a school session cookie;
  // dev_token only works when DEV_AUTH_BYPASS=true).
  let previewToken = '';
  try {
    const token = deriveEmbedToken(school.ghl_location_id);
    previewToken = token;
    const origin =
      process.env.PUBLIC_BASE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : 'https://growth-suite-dashboards.vercel.app');
    embedBaseHint = origin;
    // Default each embed URL to chrome=none so the iframe shows ONLY that
    // dashboard (no sidebar listing every dashboard for the school).
    // Operators can flip back to the with-nav variant via the toggle in
    // the Embed URLs section if they actually want the nav inside the
    // iframe.
    embedRows = dashboards.map((d) => ({
      slug: d.dashboard_slug,
      display_name: d.display_name,
      is_enabled: d.is_enabled,
      url: `${origin}/school/${school.ghl_location_id}/${d.dashboard_slug}?embed_token=${token}&chrome=none`,
      urlWithNav: `${origin}/school/${school.ghl_location_id}/${d.dashboard_slug}?embed_token=${token}`,
    }));
  } catch (e) {
    embedTokenError = e instanceof Error ? e.message : 'EMBED_TOKEN_SECRET not configured';
  }

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-4xl space-y-5">
        <div className="flex items-baseline justify-between">
          <div>
            <Link href="/admin" className="text-xs text-zinc-500 hover:text-zinc-700">
              ← All schools
            </Link>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-900">{school.name}</h1>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              location {school.ghl_location_id}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link
              href={`/admin/${schoolId}/payments`}
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
            >
              Payments →
            </Link>
            <Link
              href={`/admin/${schoolId}/menu-editors`}
              className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-900 hover:bg-blue-100"
            >
              Menu editors →
            </Link>
            <Link
              href={`/admin/${schoolId}/financial-aid/settings`}
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
            >
              Financial Aid →
            </Link>
            <Link
              href={`/school/${school.ghl_location_id}${
                previewToken
                  ? `?embed_token=${encodeURIComponent(previewToken)}`
                  : process.env.DEV_AUTH_BYPASS === 'true'
                    ? `?dev_token=${encodeURIComponent(process.env.INTERNAL_API_TOKEN ?? '')}`
                    : ''
              }`}
              target="_blank"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
            >
              Preview school view ↗
            </Link>
            <form action="/api/logout" method="POST">
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        {msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {msg}
          </div>
        ) : null}
        {err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {err}
          </div>
        ) : null}

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">Dashboards</h2>
            <span className="text-xs text-zinc-500">
              {dashboards.length} of {Object.keys(dashboardRegistry).length}
            </span>
          </div>

          {provisionableSlugs.length > 0 ? (
            <form
              action={`/api/admin/schools/${schoolId}/provision-defaults`}
              method="POST"
              className="mb-3"
            >
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
              >
                + Provision {provisionableSlugs.length} missing dashboard
                {provisionableSlugs.length === 1 ? '' : 's'}
              </button>
              <span className="ml-2 text-xs text-zinc-500">
                Adds: {provisionableSlugs.join(', ')}
              </span>
            </form>
          ) : null}

          {/* Create custom dashboard */}
          <details className="mb-3 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm open:py-3">
            <summary className="cursor-pointer text-sm font-medium text-emerald-900">
              + Create custom dashboard
            </summary>
            <form
              action={`/api/admin/schools/${schoolId}/dashboards/create`}
              method="POST"
              className="mt-2 flex flex-wrap items-end gap-2"
            >
              <label className="flex flex-col text-xs">
                <span className="text-zinc-600">Display name</span>
                <input
                  type="text"
                  name="display_name"
                  required
                  placeholder="e.g. Board of Directors View"
                  className="mt-0.5 rounded border border-zinc-300 bg-white px-2 py-1 text-sm w-64"
                />
              </label>
              <label className="flex flex-col text-xs">
                <span className="text-zinc-600">Slug (auto if blank)</span>
                <input
                  type="text"
                  name="dashboard_slug"
                  placeholder="board-of-directors"
                  pattern="[a-z0-9-]+"
                  className="mt-0.5 rounded border border-zinc-300 bg-white px-2 py-1 text-sm w-48 font-mono"
                />
              </label>
              <label className="flex flex-col flex-1 min-w-[14rem] text-xs">
                <span className="text-zinc-600">Description (optional)</span>
                <input
                  type="text"
                  name="description"
                  className="mt-0.5 rounded border border-zinc-300 bg-white px-2 py-1 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
              >
                Create &amp; configure
              </button>
            </form>
          </details>

          <div className="overflow-hidden rounded-xl border border-black/10 bg-white">
            {dashboards.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">
                No dashboards yet. Click Provision above.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-black/10 text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Dashboard</th>
                    <th className="px-4 py-3 font-medium">Slug</th>
                    <th className="px-4 py-3 font-medium text-center">Position</th>
                    <th className="px-4 py-3 font-medium text-center">Enabled</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5">
                  {dashboards.map((d, i) => (
                    <tr key={d.id}>
                      <td className="px-4 py-3 font-medium text-zinc-900">
                        <form action={`/api/admin/schools/${schoolId}/dashboards/${d.id}/rename`} method="POST" className="inline-flex items-center gap-2">
                          <input
                            type="text"
                            name="display_name"
                            defaultValue={d.display_name}
                            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm w-56"
                          />
                          <button type="submit" className="text-xs text-emerald-700 hover:underline">save</button>
                        </form>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-500">{d.dashboard_slug}</td>
                      <td className="px-4 py-3 text-center">
                        <form action={`/api/admin/schools/${schoolId}/dashboards/${d.id}/move`} method="POST" className="inline-flex items-center gap-1">
                          <button name="dir" value="up" disabled={i === 0}
                            className="rounded border border-zinc-300 bg-white px-1.5 text-xs disabled:opacity-30">↑</button>
                          <span className="px-1 text-xs">{d.position}</span>
                          <button name="dir" value="down" disabled={i === dashboards.length - 1}
                            className="rounded border border-zinc-300 bg-white px-1.5 text-xs disabled:opacity-30">↓</button>
                        </form>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <form action={`/api/admin/schools/${schoolId}/dashboards/${d.id}/toggle`} method="POST">
                          <button
                            type="submit"
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              d.is_enabled
                                ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                                : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300'
                            }`}
                          >
                            {d.is_enabled ? 'enabled' : 'disabled'}
                          </button>
                        </form>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/admin/${schoolId}/dashboard/${d.id}`}
                          className="mr-3 text-xs text-zinc-700 hover:underline"
                        >
                          configure
                        </Link>
                        <Link
                          href={`/school/${school.ghl_location_id}/${d.dashboard_slug}${
                            previewToken
                              ? `?embed_token=${encodeURIComponent(previewToken)}`
                              : process.env.DEV_AUTH_BYPASS === 'true'
                                ? `?dev_token=${encodeURIComponent(process.env.INTERNAL_API_TOKEN ?? '')}`
                                : ''
                          }`}
                          target="_blank"
                          className="text-xs text-emerald-700 hover:underline"
                        >
                          preview ↗
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">Family graph data</h2>
            <span className="text-xs text-zinc-500">syncs GHL → family-graph (snapshot)</span>
          </div>
          <div className="rounded-xl border border-black/10 bg-white p-4 space-y-3">
            <div className="flex items-baseline gap-4 text-sm text-zinc-700">
              <span><strong className="font-mono text-zinc-900">{fgCounts.families}</strong> families</span>
              <span><strong className="font-mono text-zinc-900">{fgCounts.parents}</strong> parents</span>
              <span><strong className="font-mono text-zinc-900">{fgCounts.students}</strong> students</span>
              <span><strong className="font-mono text-zinc-900">{fgCounts.enrollments}</strong> enrollments</span>
              <span><strong className="font-mono text-zinc-900">{fgCounts.classrooms}</strong> classrooms</span>
            </div>
            <form action={`/api/admin/schools/${schoolId}/sync-from-ghl`} method="POST">
              <button
                type="submit"
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
              >
                Sync from GHL now
              </button>
              <span className="ml-2 text-xs text-zinc-500">
                Pulls all GHL contacts with household_id, replaces this school&apos;s family-graph rows.
                Takes 5–30s. Cron runs every 6 hours automatically.
              </span>
            </form>

            {syncLog.length > 0 ? (
              <details className="border-t border-zinc-100 pt-2 mt-1">
                <summary className="cursor-pointer text-xs font-medium text-zinc-600 hover:text-zinc-900">
                  Recent sync activity ({syncLog.length})
                </summary>
                <ul className="mt-2 divide-y divide-zinc-100 text-[11px]">
                  {syncLog.map((row, i) => {
                    const failed = (row.error ?? '').startsWith('FAILED');
                    return (
                      <li key={i} className="flex items-baseline gap-2 py-1.5">
                        <span className="font-mono text-zinc-500 shrink-0 w-32">
                          {new Date(row.fetched_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                          })}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          row.widget_id === 'cron'
                            ? 'bg-zinc-100 text-zinc-700'
                            : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {row.widget_id}
                        </span>
                        {row.duration_ms != null ? (
                          <span className="font-mono text-zinc-400 shrink-0 w-12 text-right">
                            {row.duration_ms < 1000 ? `${row.duration_ms}ms` : `${(row.duration_ms / 1000).toFixed(1)}s`}
                          </span>
                        ) : null}
                        <span className={`min-w-0 flex-1 truncate ${failed ? 'text-rose-700' : 'text-zinc-700'}`}>
                          {row.error ?? '(no detail)'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ) : null}
          </div>
        </section>

        <section id="field-schema">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">GHL field schema</h2>
            <span className="text-xs text-zinc-500">
              {fieldSchema.is_default ? 'using built-in defaults (Desert Garden)' : 'custom (saved)'}
            </span>
          </div>
          <div className="rounded-xl border border-black/10 bg-white p-4">
            <p className="mb-3 text-xs text-zinc-600">
              Maps each abstract concept (e.g. <code className="font-mono">householdId</code>,{' '}
              <code className="font-mono">student.firstName</code>) to a GHL custom-field key.
              The sync uses these to read each contact and build family/parent/student rows.
              JSON values are the bare GHL fieldKey (no <code className="font-mono">contact.</code> prefix).
              Slot 1 student fields are bare; slot 2-N are auto-prefixed (
              <code className="font-mono">student_2_{'<'}base{'>'}</code>).
            </p>
            <form action={`/api/admin/schools/${schoolId}/field-schema`} method="POST" className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <SchemaField
                  label="family_fields"
                  name="family_fields"
                  defaultValue={JSON.stringify(fieldSchema.family_fields, null, 2)}
                  hint="Per-family fields. Must include 'householdId' or sync skips all contacts."
                />
                <SchemaField
                  label="parent2_fields"
                  name="parent2_fields"
                  defaultValue={JSON.stringify(fieldSchema.parent2_fields, null, 2)}
                  hint="Parent 2 (P1 = the contact itself)."
                />
                <SchemaField
                  label="student_fields"
                  name="student_fields"
                  defaultValue={JSON.stringify(fieldSchema.student_fields, null, 2)}
                  hint="Per-student. Must include 'firstName' or no students get synced."
                />
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1">
                  max student slots:
                  <input
                    type="number"
                    name="max_student_slots"
                    min={1}
                    max={10}
                    defaultValue={fieldSchema.max_student_slots}
                    className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-1"
                  />
                </label>
                <label className="flex items-center gap-1">
                  default academic year:
                  <input
                    type="text"
                    name="default_academic_year"
                    defaultValue={fieldSchema.default_academic_year}
                    className="w-24 rounded border border-zinc-300 bg-white px-1.5 py-1 font-mono"
                  />
                </label>
                <label className="flex flex-1 items-center gap-1">
                  notes:
                  <input
                    type="text"
                    name="notes"
                    defaultValue={fieldSchema.notes ?? ''}
                    className="flex-1 rounded border border-zinc-300 bg-white px-1.5 py-1"
                  />
                </label>
              </div>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
              >
                Save field schema
              </button>
              <span className="ml-2 text-xs text-zinc-500">
                Saving doesn&apos;t re-sync — click &quot;Sync from GHL now&quot; above after saving.
              </span>
            </form>
          </div>
        </section>

        {embedTokenError ? (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Embed URLs unavailable: {embedTokenError}. Set EMBED_TOKEN_SECRET in Vercel env.
          </div>
        ) : embedRows.length > 0 ? (
          <EmbedUrlsSection rows={embedRows} baseHint={embedBaseHint} />
        ) : null}

        {/* Promote Parent 2 to its own GHL contact */}
        <section id="promote-parent2">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">Parent 2 → GHL contacts</h2>
            <span className="text-xs text-zinc-500">creates standalone contacts + co-parent links</span>
          </div>
          <div className="rounded-xl border border-black/10 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
              <span><strong className="font-mono text-zinc-900">{p2Counts.total_with_p2}</strong> families with Parent 2 on file</span>
              <span className="text-zinc-500">
                <strong className="font-mono text-zinc-900">{p2Counts.p2_with_email}</strong> have an email
              </span>
              <span className="text-emerald-700">
                <strong className="font-mono">{p2Counts.p2_promoted}</strong> already promoted to GHL contact
              </span>
              <span className={Number(p2Counts.p2_promotable) > 0 ? 'text-amber-700' : 'text-zinc-500'}>
                <strong className="font-mono">{p2Counts.p2_promotable}</strong> ready to promote
              </span>
            </div>
            <p className="text-xs text-zinc-600">
              Creates a separate GHL contact for each Parent 2 (so they can be emailed / put in
              automations directly), then links Parent 1 ↔ Parent 2 in GHL with a{' '}
              <code className="font-mono">co_parent</code> relationship. Idempotent — already-promoted
              families are skipped.
            </p>
            <div className="flex flex-wrap gap-2">
              <form action={`/api/admin/schools/${schoolId}/promote-parent2`} method="POST">
                <input type="hidden" name="dry_run" value="1" />
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                >
                  Preview (dry run)
                </button>
              </form>
              <form action={`/api/admin/schools/${schoolId}/promote-parent2`} method="POST">
                <button
                  type="submit"
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
                  disabled={Number(p2Counts.p2_promotable) === 0}
                >
                  Promote all {p2Counts.p2_promotable} now
                </button>
              </form>
            </div>
            <p className="text-[11px] text-zinc-500">
              Tip: run dry run first to see the counts. For a single-family smoke test, you can use
              the v1 API directly: <code className="font-mono">POST /api/admin/schools/&#123;id&#125;/promote-parent2</code>{' '}
              with <code className="font-mono">family_id=&lt;uuid&gt;</code> in the form body.
            </p>
          </div>
        </section>

        {/* Family uploads — link to dedicated page */}
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">Family uploads</h2>
            <Link href={`/admin/${schoolId}/uploads`} className="text-xs text-emerald-700 hover:underline">
              View all →
            </Link>
          </div>
          <div className="rounded-xl border border-black/10 bg-white p-4">
            <div className="flex flex-wrap items-baseline gap-4 text-sm">
              <span><strong className="font-mono text-zinc-900">{uploadCounts.total}</strong> total</span>
              <span className="text-zinc-500">
                <strong className={`font-mono ${Number(uploadCounts.pending_sync) > 0 ? 'text-amber-700' : 'text-zinc-900'}`}>
                  {uploadCounts.pending_sync}
                </strong> pending sync to GHL
              </span>
              <span className="text-zinc-500">
                <strong className={`font-mono ${Number(uploadCounts.failed_sync) > 0 ? 'text-rose-700' : 'text-zinc-900'}`}>
                  {uploadCounts.failed_sync}
                </strong> failed sync
              </span>
              <span className="text-zinc-500">
                <strong className="font-mono text-zinc-900">{uploadCounts.unacknowledged}</strong> awaiting school acknowledgment
              </span>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Documents parents upload via the portal go here. Each one auto-pushes to GHL Media +
              the parent&apos;s conversation thread.
            </p>
          </div>
        </section>

        <section id="parent-portal">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-lg font-semibold">Parent portal</h2>
            <span className="text-xs text-zinc-500">
              <a href="https://growth-suite-parent-portal.vercel.app" target="_blank" rel="noopener noreferrer" className="underline">
                live at family.mygrowthsuite.com
              </a>
            </span>
          </div>

          {/* Branding */}
          <div className="rounded-xl border border-black/10 bg-white p-4 mb-3">
            <h3 className="mb-2 text-sm font-semibold text-zinc-900">Branding</h3>
            <form action={`/api/admin/schools/${schoolId}/parent-portal-branding`} method="POST" className="space-y-2 text-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Field label="Display name (overrides school name)" name="display_name" defaultValue={branding?.display_name ?? ''} placeholder={school.name} />
                <Field label="Logo URL" name="logo_url" defaultValue={branding?.logo_url ?? ''} placeholder="https://..." />
                <Field label="Primary color (hex)" name="primary_color" defaultValue={branding?.primary_color ?? '#047857'} className="font-mono" />
                <Field label="Soft (light bg)" name="primary_color_soft" defaultValue={branding?.primary_color_soft ?? '#ecfdf5'} className="font-mono" />
                <Field label="Foreground (text on soft)" name="primary_color_fg" defaultValue={branding?.primary_color_fg ?? '#064e3b'} className="font-mono" />
                <Field label="Support email" name="support_email" type="email" defaultValue={branding?.support_email ?? ''} />
                <Field label="Support phone" name="support_phone" type="tel" defaultValue={branding?.support_phone ?? ''} />
              </div>
              <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800">
                Save branding
              </button>
            </form>
          </div>

          {/* Portal menus on/off */}
          <div id="portal-menus" className="rounded-xl border border-black/10 bg-white p-4">
            <h3 className="mb-1 text-sm font-semibold text-zinc-900">Portal menus</h3>
            <p className="mb-3 text-[11px] text-zinc-500">
              Turn parent-portal menu items on or off. Items turned off disappear from the
              parent&rsquo;s navigation. Home is always shown.
            </p>
            <form action={`/api/admin/schools/${schoolId}/portal-menus`} method="POST" className="space-y-2.5 text-sm">
              <input type="hidden" name="all_nav" value={PORTAL_NAV.map((n) => n.href).join(',')} />
              {/* Home is always visible — submit it regardless of the (disabled) box. */}
              <input type="hidden" name="visible" value="/home" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                {PORTAL_NAV.map((n) => {
                  const pinned = n.href === '/home';
                  return (
                    <label key={n.href} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={pinned ? undefined : 'visible'}
                        value={n.href}
                        defaultChecked={pinned || !hiddenNav.has(n.href)}
                        disabled={pinned}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                      <span className={pinned ? 'text-zinc-400' : 'text-zinc-800'}>{n.label}</span>
                    </label>
                  );
                })}
              </div>
              <button type="submit" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800">
                Save portal menus
              </button>
            </form>
          </div>

          {/* Forms */}
          <div className="rounded-xl border border-black/10 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-900">
              Forms parents see ({portalForms.length})
            </h3>

            {portalForms.length > 0 ? (
              <ul className="mb-3 divide-y divide-zinc-100">
                {portalForms.map((f) => (
                  <li key={f.id} className="py-2">
                    <form action={`/api/admin/schools/${schoolId}/parent-portal-forms`} method="POST" className="flex flex-wrap items-center gap-2 text-xs">
                      <input type="hidden" name="op" value="update" />
                      <input type="hidden" name="form_id" value={f.id} />
                      <input type="text" name="display_name" defaultValue={f.display_name} className="rounded border border-zinc-300 px-2 py-1 text-sm w-48" placeholder="Form name" />
                      <input type="text" name="completion_field_key" defaultValue={f.completion_field_key} className="rounded border border-zinc-300 px-2 py-1 text-sm w-48 font-mono" placeholder="completion_field_key" />
                      <input type="url" name="fill_out_url" defaultValue={f.fill_out_url ?? ''} className="rounded border border-zinc-300 px-2 py-1 text-sm w-56" placeholder="https://..." />
                      <label className="flex items-center gap-1"><input type="checkbox" name="per_student" defaultChecked={f.per_student} /> per-student</label>
                      <label className="flex items-center gap-1"><input type="checkbox" name="is_active" defaultChecked={f.is_active} /> active</label>
                      <input type="number" name="position" defaultValue={f.position} className="w-12 rounded border border-zinc-300 px-1 py-1 text-sm" />
                      <button type="submit" className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-800">save</button>
                    </form>
                    <form action={`/api/admin/schools/${schoolId}/parent-portal-forms`} method="POST" className="mt-1">
                      <input type="hidden" name="op" value="delete" />
                      <input type="hidden" name="form_id" value={f.id} />
                      <button type="submit" className="text-[11px] text-red-600 hover:underline">remove</button>
                      {f.description ? <span className="ml-3 text-[11px] text-zinc-500">{f.description}</span> : null}
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-xs text-zinc-500">No forms configured yet — add one below.</p>
            )}

            {/* Add new form */}
            <form action={`/api/admin/schools/${schoolId}/parent-portal-forms`} method="POST" className="space-y-2 text-sm border-t border-zinc-100 pt-3">
              <input type="hidden" name="op" value="add" />
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-700">Add new form</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Field label="Display name" name="display_name" required placeholder="Re-enrollment 2026-27" />
                <Field label="Completion field key (GHL)" name="completion_field_key" required placeholder="reenroll_form_submitted" className="font-mono" />
                <Field label="Fill-out URL" name="fill_out_url" type="url" placeholder="https://forms.school.com/..." />
                <Field label="Description (optional)" name="description" />
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" name="per_student" defaultChecked /> Per-student (slot-prefixed)</label>
                <label className="flex items-center gap-1"><input type="checkbox" name="is_active" defaultChecked /> Active</label>
                <label className="flex items-center gap-1">Position: <input type="number" name="position" defaultValue={portalForms.length} className="w-12 rounded border border-zinc-300 px-1 py-1 text-sm" /></label>
              </div>
              <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                Add form
              </button>
            </form>
          </div>
        </section>

        <p className="text-xs text-zinc-500">
          Per-widget config editing is operator-side via curl/PATCH for v1. Drag-and-drop layout
          editing is phase 2.
        </p>
      </div>
    </main>
  );
}

function Field({
  label, name, defaultValue, placeholder, type, required, className,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">{label}</span>
      <input
        name={name}
        type={type ?? 'text'}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className={`mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 text-sm focus:border-zinc-500 focus:outline-none ${className ?? ''}`}
      />
    </label>
  );
}

function SchemaField({
  label,
  name,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string;
  hint: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="text-xs font-mono text-zinc-700">{label}</label>
      <textarea
        id={name}
        name={name}
        defaultValue={defaultValue}
        rows={12}
        spellCheck={false}
        className="mt-1 w-full rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed focus:border-zinc-500 focus:bg-white focus:outline-none"
      />
      <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>
    </div>
  );
}
