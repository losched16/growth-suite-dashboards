// /school/[locationId]/settings — school-facing portal settings: branding
// + which parent-portal menus are on/off. Mirrors the operator branding /
// portal-menu editors but lives under /school so a school's own staff can
// self-serve (auth handled by the /school layout). Saves via the
// school-scoped /api/school/[locationId]/portal-settings endpoint.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadSchoolSettings, GHL_MENU_ITEMS } from '@/lib/school-settings';
import { PORTAL_NAV } from '@/lib/portal-nav';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

interface BrandingRow {
  display_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  primary_color_soft: string | null;
  primary_color_fg: string | null;
  support_email: string | null;
  support_phone: string | null;
  portal_hidden_nav: string[] | null;
}

export default async function SchoolSettingsPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows } = await query<BrandingRow>(
    `SELECT display_name, logo_url, primary_color, primary_color_soft, primary_color_fg,
            support_email, support_phone, portal_hidden_nav
       FROM school_branding WHERE school_id = $1`,
    [school.id],
  );
  const b = rows[0] ?? null;
  const hidden = new Set(b?.portal_hidden_nav ?? []);
  const settings = await loadSchoolSettings(school.id);
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const err = typeof sp.err === 'string' ? sp.err : null;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-2xl space-y-4">
        <Link href={`/school/${locationId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Portal settings</h1>
          <p className="text-xs text-slate-500 mt-0.5">{school.name} — branding and which menus parents see.</p>
        </div>

        {msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div> : null}

        <form action={`/api/school/${locationId}/portal-settings`} method="POST" className="space-y-5">
          {/* Branding */}
          <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">Branding</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Field label="Display name (overrides school name)" name="display_name" defaultValue={b?.display_name ?? ''} placeholder={school.name} />
              <Field label="Logo URL" name="logo_url" defaultValue={b?.logo_url ?? ''} placeholder="https://…" />
              <Field label="Primary color (hex)" name="primary_color" defaultValue={b?.primary_color ?? '#047857'} mono />
              <Field label="Soft (light background)" name="primary_color_soft" defaultValue={b?.primary_color_soft ?? '#ecfdf5'} mono />
              <Field label="Foreground (text on soft)" name="primary_color_fg" defaultValue={b?.primary_color_fg ?? '#064e3b'} mono />
              <Field label="Support email" name="support_email" type="email" defaultValue={b?.support_email ?? ''} />
              <Field label="Support phone" name="support_phone" type="tel" defaultValue={b?.support_phone ?? ''} />
            </div>
          </section>

          {/* Portal menus */}
          <section className="rounded-xl border border-black/10 bg-white p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">Portal menus</h2>
            <p className="text-[11px] text-slate-500">
              Turn parent-portal menu items on or off. Items turned off disappear from parents&rsquo; navigation. Home is always shown.
            </p>
            <input type="hidden" name="all_nav" value={PORTAL_NAV.map((n) => n.href).join(',')} />
            <input type="hidden" name="visible" value="/home" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 text-sm">
              {PORTAL_NAV.map((n) => {
                const pinned = n.href === '/home';
                return (
                  <label key={n.href} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name={pinned ? undefined : 'visible'}
                      value={n.href}
                      defaultChecked={pinned || !hidden.has(n.href)}
                      disabled={pinned}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <span className={pinned ? 'text-slate-400' : 'text-slate-800'}>{n.label}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
            Save settings
          </button>
        </form>

        {/* School behavior settings (schools.settings) — its own form/endpoint
            so a branding save can't clobber these and vice versa. */}
        <form action={`/api/school/${locationId}/school-settings`} method="POST" className="space-y-5">
          <section className="rounded-xl border border-black/10 bg-white p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">School &amp; sync settings</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                How your Growth Suite data drives the portal. Everything here keys off your contact records.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Field label="Academic year" name="academic_year" defaultValue={settings.academic_year} placeholder="2026-27" mono />
              <Field
                label="Portal access opens at pipeline stage (blank = any parent can create a login)"
                name="portal_gate_stage"
                defaultValue={settings.portal_gate_stage ?? ''}
                placeholder="e.g. Pending"
              />
              <Field
                label="Roster tag filter (comma-separated; blank = every contact with student data)"
                name="roster_tag_filter"
                defaultValue={settings.roster_tag_filter.join(', ')}
                placeholder="e.g. 2026-27 stms, withdrawn"
              />
            </div>
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" name="auto_student_ids" defaultChecked={settings.auto_student_ids} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                <span>
                  <span className="text-slate-800 font-medium">Auto-assign Student IDs</span>
                  <span className="block text-[11px] text-slate-500">Students missing an ID get a unique 8-digit one, written to the contact record first. Existing IDs are never changed.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" name="promote_parent2" defaultChecked={settings.promote_parent2} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                <span>
                  <span className="text-slate-800 font-medium">Create a contact for Parent 2 (email marketing)</span>
                  <span className="block text-[11px] text-slate-500">Each second parent/guardian gets their own contact record nightly, tagged and associated with the family, so you can email both parents.</span>
                </span>
              </label>
            </div>
            {/* CRM sidebar menus — hidden per sub-account via the agency
                Custom JS snippet (docs/ghl-menu-snippet.js). Unchecked = hidden. */}
            <div className="border-t border-slate-100 pt-4">
              <h3 className="text-sm font-semibold text-slate-900">CRM sidebar menus</h3>
              <p className="text-[11px] text-slate-500 mt-0.5 mb-2">
                Turn CRM sidebar items on or off for this school&rsquo;s account. Cosmetic decluttering — use user permissions for real access control. Takes effect within ~5 minutes of saving (on next page load).
              </p>
              <input type="hidden" name="all_crm_menu" value={GHL_MENU_ITEMS.map((m) => m.key).join(',')} />
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 text-sm">
                {GHL_MENU_ITEMS.map((m) => (
                  <label key={m.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="crm_visible"
                      value={m.key}
                      defaultChecked={!settings.ghl_hidden_menu.includes(m.key)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <span className="text-slate-800">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Save school settings
            </button>
          </section>
        </form>
      </div>
    </main>
  );
}

function Field({
  label, name, defaultValue, placeholder, type = 'text', mono = false,
}: {
  label: string; name: string; defaultValue?: string; placeholder?: string;
  type?: string; mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-slate-600">{label}</span>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={`mt-1 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}
