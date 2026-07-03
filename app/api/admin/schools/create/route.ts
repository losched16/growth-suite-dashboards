// Onboard a new school. Form fields:
//   - name (required)
//   - ghl_location_id (required) — from GHL Settings → Business Info
//   - ghl_pit (required) — Private Integration Token with scopes:
//       contacts.readonly, contacts.write,
//       locations/customFields.readonly,
//       associations.write, associations/relation.write,
//       opportunities.readonly, conversations.readonly, conversations/message.write
//
// Behavior:
//   1. Validates the PIT by hitting /locations/{id}/customFields
//   2. AES-256-GCM encrypts the PIT
//   3. Inserts row into schools
//   4. Redirects to /admin/{newSchoolId} for sync + promote-p2

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import axios from 'axios';
import { query, withTransaction } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { DASHBOARD_TEMPLATES } from '@/lib/dashboards/templates';

export const maxDuration = 30;

// Starter dashboards come from the shared template registry
// (lib/dashboards/templates.ts) — the SAME templates the school's own
// "Add dashboard" gallery offers, so there is one source of truth. These
// three don't query the DB, so building before the first sync is safe;
// the school adds more (incl. classroom hubs) from its gallery later.
const STARTER_TEMPLATE_KEYS = ['family-hub', 'student-roster', 'enrollment-hub'];

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const locationId = String(form.get('ghl_location_id') ?? '').trim();
    const pit = String(form.get('ghl_pit') ?? '').trim();
    const academicYear = String(form.get('academic_year') ?? '').trim() || '2026-27';
    if (!/^\d{4}-\d{2}$/.test(academicYear)) {
      return back(request, { err: 'Academic year must look like 2026-27.' });
    }

    if (!name) return back(request, { err: 'School name is required.' });
    if (!locationId) return back(request, { err: 'GHL Location ID is required.' });
    if (!pit) return back(request, { err: 'GHL Private Integration Token is required.' });

    // Reject obvious duplicate location_id up-front (saves a round-trip)
    const { rows: dup } = await query<{ id: string }>(
      `SELECT id FROM schools WHERE ghl_location_id = $1`,
      [locationId],
    );
    if (dup.length > 0) {
      return back(request, {
        err: `A school with this GHL Location ID already exists (id ${dup[0].id.slice(0, 8)}…).`,
      });
    }

    // Probe GHL to validate the PIT before storing anything
    try {
      await axios.get(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
        headers: {
          Authorization: `Bearer ${pit}`,
          Version: '2021-07-28',
          Accept: 'application/json',
        },
        timeout: 10_000,
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      return back(request, {
        err: `Couldn't validate PIT against GHL (HTTP ${status ?? '?'}): ${msg ?? 'check that the location ID is correct and the PIT has the customFields scope'}`,
      });
    }

    // Encrypt + insert all the defaults in one transaction. If any step
    // fails we want NONE of it (no half-provisioned school with a row
    // but no dashboards / no payment config).
    const { ciphertext, iv, tag } = encrypt(pit);
    const schoolId = await withTransaction(async (q) => {
      const { rows } = await q<{ id: string }>(
        `INSERT INTO schools (name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag, settings)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [name, locationId, ciphertext, iv, tag, JSON.stringify({ academic_year: academicYear })],
      );
      const id = rows[0].id;

      // Starter dashboards from the shared template registry.
      let position = 0;
      for (const key of STARTER_TEMPLATE_KEYS) {
        const template = DASHBOARD_TEMPLATES.find((x) => x.key === key);
        if (!template) continue;
        for (const d of await template.build(id, academicYear)) {
          position++;
          await q(
            `INSERT INTO school_dashboards
               (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
             VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
             ON CONFLICT (school_id, dashboard_slug) DO NOTHING`,
            [id, d.dashboard_slug, d.display_name, d.description, JSON.stringify(d.layout), position],
          );
        }
      }

      // Payment config row — billing_active defaults to false (dry-run
      // mode from day one, see migration 046). Schools always start with
      // a sensible config; admin can tweak via Payments → Settings later.
      await q(
        `INSERT INTO school_payment_config (school_id)
         VALUES ($1)
         ON CONFLICT (school_id) DO NOTHING`,
        [id],
      );

      // Blank branding row so /admin/{schoolId}/branding has something to
      // edit. Defaults are fine; admin can customize the logo / support
      // email later.
      await q(
        `INSERT INTO school_branding (school_id)
         VALUES ($1)
         ON CONFLICT (school_id) DO NOTHING`,
        [id],
      ).catch(() => undefined); // table may not exist on older DBs

      return id;
    });

    const url = request.nextUrl.clone();
    url.pathname = `/admin/${schoolId}`;
    url.search = '';
    url.searchParams.set('msg',
      `Created "${name}" (${academicYear}) with starter dashboards + payment config (dry-run mode). ` +
      `Next: 1) run the Field audit (/admin/${schoolId}/field-audit) to verify the location's custom fields, ` +
      `2) "Sync from GHL" — after that the school self-serves: Settings, Add dashboard (incl. classroom hubs), ` +
      `Forms → New form (templates), and Payments (tuition grids + plans).`,
    );
    return NextResponse.redirect(url, 303);
  } catch (err) {
    return back(request, {
      err: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function back(request: NextRequest, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = '/admin/schools/new';
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
