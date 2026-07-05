// Provision a new school tenant — the reusable core shared by the operator
// "Add school" form (app/api/admin/schools/create) and the one-click
// "Provision & connect" action on the onboarding board.
//
// Validates the PIT against the location, then in one transaction creates the
// schools row (with academic-year setting), starter dashboards, payment
// config (billing_active=false / dry-run), and a branding row; finally derives
// + stores the field schema from the location's actual custom fields.

import axios from 'axios';
import { query, withTransaction } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { DASHBOARD_TEMPLATES } from '@/lib/dashboards/templates';
import { deriveFieldSchemaFromKeys } from '@/lib/sync/derive-field-schema';
import { upsertSchoolFieldSchema } from '@/lib/sync/schema-loader';

// Starter dashboards from the shared template registry — the SAME templates
// the school's "Add dashboard" gallery offers. These three don't query the DB,
// so building before the first sync is safe.
const STARTER_TEMPLATE_KEYS = ['family-hub', 'student-roster', 'enrollment-hub'];

export type ProvisionErrorCode = 'validation' | 'duplicate' | 'pit_invalid';

export class ProvisionSchoolError extends Error {
  constructor(public code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = 'ProvisionSchoolError';
  }
}

export interface ProvisionSchoolResult {
  schoolId: string;
  academicYear: string;
}

export async function provisionSchool(opts: {
  name: string;
  locationId: string;
  pit: string;
  academicYear?: string;
}): Promise<ProvisionSchoolResult> {
  const name = opts.name.trim();
  const locationId = opts.locationId.trim();
  const pit = opts.pit.trim();
  const academicYear = (opts.academicYear ?? '').trim() || '2026-27';

  if (!name) throw new ProvisionSchoolError('validation', 'School name is required.');
  if (!locationId) throw new ProvisionSchoolError('validation', 'GHL Location ID is required.');
  if (!pit) throw new ProvisionSchoolError('validation', 'GHL Private Integration Token is required.');
  if (!/^\d{4}-\d{2}$/.test(academicYear)) {
    throw new ProvisionSchoolError('validation', 'Academic year must look like 2026-27.');
  }

  // Reject a duplicate location up-front.
  const { rows: dup } = await query<{ id: string }>(
    `SELECT id FROM schools WHERE ghl_location_id = $1`, [locationId]);
  if (dup.length > 0) {
    throw new ProvisionSchoolError('duplicate',
      `A school with this GHL Location ID already exists (id ${dup[0].id.slice(0, 8)}…).`);
  }

  // Validate the PIT — the response doubles as the field-schema input.
  let locationFieldKeys: string[] = [];
  try {
    const { data } = await axios.get<{ customFields?: Array<{ fieldKey?: string }> }>(
      `https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
      headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' },
      timeout: 10_000,
    });
    locationFieldKeys = (data.customFields ?? []).map((f) => String(f.fieldKey ?? '')).filter(Boolean);
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
    throw new ProvisionSchoolError('pit_invalid',
      `Couldn't validate PIT against GHL (HTTP ${status ?? '?'}): ${msg ?? 'check the location ID and that the PIT has the customFields scope'}`);
  }

  // Encrypt + insert all defaults atomically.
  const { ciphertext, iv, tag } = encrypt(pit);
  const schoolId = await withTransaction(async (q) => {
    const { rows } = await q<{ id: string }>(
      `INSERT INTO schools (name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag, settings)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [name, locationId, ciphertext, iv, tag, JSON.stringify({ academic_year: academicYear })],
    );
    const id = rows[0].id;

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

    await q(
      `INSERT INTO school_payment_config (school_id) VALUES ($1) ON CONFLICT (school_id) DO NOTHING`,
      [id]);
    await q(
      `INSERT INTO school_branding (school_id) VALUES ($1) ON CONFLICT (school_id) DO NOTHING`,
      [id]).catch(() => undefined);

    return id;
  });

  // Derive + store the field schema from the location's real fields. householdId
  // is stored explicitly '' when absent — the loader merges the DG preset
  // underneath saved rows, and only an explicit empty overrides its householdId
  // (absence gets resurrected → the sync would gate on a nonexistent field and
  // map zero families).
  try {
    const derived = deriveFieldSchemaFromKeys(locationFieldKeys);
    await upsertSchoolFieldSchema(schoolId, {
      family_fields: { householdId: '', ...derived.family_fields },
      parent2_fields: derived.parent2_fields,
      student_fields: derived.student_fields,
      max_student_slots: derived.max_student_slots,
      default_academic_year: academicYear,
      notes: 'auto-derived at onboarding',
      allow_parent_only_families: false,
    });
  } catch (e) {
    console.warn('[provisionSchool] field-schema derivation failed (sync will use defaults):', e);
  }

  return { schoolId, academicYear };
}
