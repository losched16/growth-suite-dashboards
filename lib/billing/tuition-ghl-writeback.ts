// Push tuition enrollment data back to the family's GHL contact
// record. Closes the loop between FACTS CSV import → our DB → GHL
// (canonical persistent source of truth).
//
// What we write (per student slot):
//   - student_N_total_tuition_cost   ← annual_tuition_cents in dollars
//   - student_N_total_amount         ← total_annual_cents in dollars
//   - student_N_payment_plan         ← plan display name (string)
//
// Slot lookup: students.metadata.slot. Field-key resolution uses the
// school's school_field_schemas (with DG fallback) + the
// studentFieldKey(slot, baseKey) helper.
//
// Best-effort — errors are logged but don't fail the calling import.
// GHL writes are PUT (full custom-field replacement on listed keys
// only; other fields untouched).

import { query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { loadSchoolFieldSchema } from '@/lib/sync/schema-loader';
import { studentFieldKey } from '@/lib/sync/desert-garden-config';

interface EnrollmentSnapshotRow {
  school_id: string;
  family_id: string;
  student_id: string;
  annual_tuition_cents: number;
  total_annual_cents: number;
  student_slot: number;
  primary_parent_ghl_contact_id: string | null;
  payment_plan_display: string | null;
}

interface CustomFieldDef { id: string; fieldKey?: string }

export interface TuitionWritebackResult {
  ok: boolean;
  reason?: string;
  contactId?: string;
  fieldsWritten?: string[];
  fieldsSkipped?: string[];
}

export async function writebackTuitionEnrollmentToGhl(
  enrollmentId: string,
): Promise<TuitionWritebackResult> {
  const { rows } = await query<EnrollmentSnapshotRow>(
    `SELECT fte.school_id, fte.family_id, fte.student_id,
            fte.annual_tuition_cents, fte.total_annual_cents,
            COALESCE((s.metadata->>'slot')::int, 1) AS student_slot,
            (SELECT p.ghl_contact_id FROM parents p
              WHERE p.family_id = fte.family_id AND p.is_primary = true
                AND p.ghl_contact_id IS NOT NULL
              ORDER BY p.created_at LIMIT 1) AS primary_parent_ghl_contact_id,
            (SELECT pp.display_name FROM payment_plans pp WHERE pp.id = fte.payment_plan_id) AS payment_plan_display
       FROM family_tuition_enrollments fte
       JOIN students s ON s.id = fte.student_id
      WHERE fte.id = $1`,
    [enrollmentId],
  );
  if (rows.length === 0) return { ok: false, reason: 'enrollment_not_found' };
  const e = rows[0];
  if (!e.primary_parent_ghl_contact_id) {
    return { ok: false, reason: 'no_ghl_contact_for_family' };
  }

  let client: GhlClient;
  try {
    client = await loadGhlClient(e.school_id);
  } catch (err) {
    return { ok: false, reason: `ghl_client: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Resolve the school's per-slot GHL field keys for the three fields
  // we care about.
  const schema = await loadSchoolFieldSchema(e.school_id);
  const sf = schema.student_fields as Record<string, string>;
  const writes: Record<string, string> = {};
  const tuitionKey      = sf.totalTuitionCost ?? sf.tuitionFee ?? 'tuition_fee';
  const totalAmountKey  = sf.totalAmount ?? 'total_amount';
  const planKey         = sf.paymentPlan ?? 'payment_plan';

  writes[studentFieldKey(e.student_slot, tuitionKey)] = (e.annual_tuition_cents / 100).toFixed(2);
  writes[studentFieldKey(e.student_slot, totalAmountKey)] = (e.total_annual_cents / 100).toFixed(2);
  if (e.payment_plan_display) {
    writes[studentFieldKey(e.student_slot, planKey)] = e.payment_plan_display;
  }

  // Resolve GHL field IDs from the location's customFields catalog.
  // Cache per-process for the life of the request via the client.
  type Cf = { customFields?: CustomFieldDef[] };
  const { data: cfData } = await client.axios.get<Cf>(`/locations/${client.locationId}/customFields`);
  const idByKey = new Map<string, string>();
  for (const f of cfData.customFields ?? []) {
    const k = (f.fieldKey ?? '').replace(/^contact\./, '');
    if (k) idByKey.set(k, f.id);
  }

  const customFields: Array<{ id: string; field_value: string }> = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(writes)) {
    const id = idByKey.get(key);
    if (!id) { skipped.push(key); continue; }
    customFields.push({ id, field_value: value });
  }

  if (customFields.length === 0) {
    return { ok: false, reason: 'no_matching_ghl_fields', fieldsSkipped: skipped };
  }

  try {
    await client.axios.put(`/contacts/${e.primary_parent_ghl_contact_id}`, { customFields });
  } catch (err) {
    return { ok: false, reason: `ghl_put_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    ok: true,
    contactId: e.primary_parent_ghl_contact_id,
    fieldsWritten: customFields.map((c) => c.id),
    fieldsSkipped: skipped,
  };
}

// Bulk variant — runs writeback for every committed enrollment in a
// school/year. Used after a FACTS import commits, but can also be
// invoked manually from an admin "Sync all to GHL" button later.
export async function bulkWritebackTuitionForSchoolYear(
  schoolId: string,
  academicYear: string,
): Promise<{ total: number; ok: number; skipped: number; failed: number }> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM family_tuition_enrollments
      WHERE school_id = $1 AND academic_year = $2
        AND status IN ('draft', 'committed')`,
    [schoolId, academicYear],
  );

  let ok = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    try {
      const r = await writebackTuitionEnrollmentToGhl(row.id);
      if (r.ok) ok++;
      else skipped++;
    } catch (err) {
      console.warn('[tuition-ghl] writeback error for', row.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }
  return { total: rows.length, ok, skipped, failed };
}
