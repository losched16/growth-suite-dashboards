// POST /api/admin/onboarding/[id]/provision — one-click "Provision & connect".
// Operator-only. From a location ID + PIT: pushes the Growth Suite field kit
// into the GHL sub-account, creates the school tenant (starter dashboards,
// payment config, derived field schema), links the onboarding to it, and runs
// the field audit. Turns a lead into a connected, audited school in one step.
//
// ⚠️ LIVE GHL WRITES (creates ~150 custom fields + tags). Idempotent — safe to
// re-run; existing fields are skipped.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { provisionFieldKit } from '@/lib/onboarding/provision-field-kit';
import { provisionSchool, ProvisionSchoolError } from '@/lib/onboarding/provision-school';
import { auditGhlFields, type GhlFieldDef } from '@/lib/onboarding/field-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // field-kit push is ~150 paced GHL writes

type Params = Promise<{ id: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/admin/onboarding/${id}`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  // Load the onboarding; must exist and not already be provisioned.
  const { rows: obRows } = await query<{ school_id: string | null; school_name: string }>(
    `SELECT school_id, school_name FROM school_onboarding WHERE id = $1`, [id]);
  const ob = obRows[0];
  if (!ob) return back({ err: 'Onboarding not found.' });
  if (ob.school_id) return back({ err: 'This onboarding is already connected to a school.' });

  const form = await request.formData();
  const locationId = String(form.get('ghl_location_id') ?? '').trim();
  const pit = String(form.get('ghl_pit') ?? '').trim();
  const name = String(form.get('name') ?? '').trim() || ob.school_name;
  const academicYear = String(form.get('academic_year') ?? '').trim();
  const skipKit = form.get('skip_field_kit') === 'on';

  if (!locationId || !pit) {
    return back({ err: 'GHL Location ID and Private Integration Token are required.' });
  }

  try {
    // 1. Push the field kit (unless the location already has it and ops opts
    //    out). Idempotent — existing fields are skipped.
    let kitMsg = 'field kit skipped';
    if (!skipKit) {
      const kit = await provisionFieldKit(locationId, pit);
      kitMsg = `${kit.created} fields created, ${kit.skipped} existing${kit.failed ? `, ${kit.failed} failed` : ''}`;
      if (kit.failed > 0 && kit.created === 0 && kit.skipped === 0) {
        return back({ err: `Field-kit push failed — check the PIT scopes. First error: ${kit.errors[0] ?? 'unknown'}` });
      }
    }

    // 2. Create the school tenant (validates the PIT, stores it encrypted,
    //    builds starter dashboards + payment config + field schema).
    const { schoolId } = await provisionSchool({ name, locationId, pit, academicYear });

    // 3. Link the onboarding to the new tenant.
    await query(
      `UPDATE school_onboarding
          SET school_id = $2, ghl_location_id = $3, stage = 'data', updated_at = now()
        WHERE id = $1`,
      [id, schoolId, locationId]);

    // 4. Run the field audit for an at-a-glance summary.
    let auditMsg = '';
    try {
      const client = await loadGhlClient(schoolId);
      const { data } = await client.axios.get<{ customFields?: GhlFieldDef[] }>(
        `/locations/${client.locationId}/customFields`);
      const audit = auditGhlFields(data.customFields ?? []);
      const fails = audit.items.filter((i) => i.level === 'fail').length;
      const warns = audit.items.filter((i) => i.level === 'warn').length;
      auditMsg = audit.ok
        ? ` Field audit: all green (${audit.slots_detected} student slots).`
        : ` Field audit: ${fails} blocking, ${warns} warning(s) — see /admin/${schoolId}/field-audit.`;
    } catch {
      auditMsg = ` (Run the field audit at /admin/${schoolId}/field-audit.)`;
    }

    return back({
      msg: `Provisioned & connected "${name}" → school ${schoolId.slice(0, 8)}…. Field kit: ${kitMsg}.${auditMsg} Next: submit intake + apply, then Sync from GHL.`,
    });
  } catch (err) {
    if (err instanceof ProvisionSchoolError) {
      // Duplicate = the location is already a school; surface a clear message.
      return back({ err: err.message });
    }
    return back({ err: `Provisioning failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
