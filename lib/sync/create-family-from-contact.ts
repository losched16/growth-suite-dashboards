// Enrollment trigger — turn a single GHL contact into a loginable family.
//
// When an admissions opportunity reaches an "Enrolled" stage, we want that
// family to appear in Growth Suite with portal access — without a full
// (destructive) snapshot sync and without an import. This module does the
// minimal, additive create:
//
//   createFamilyFromContact(schoolId, contactId)
//     - idempotent: skips if a parent already links to this GHL contact
//     - reuses the snapshot sync's contact→family mapper (relaxed so a
//       just-enrolled contact without household_id / student rows still
//       becomes a loginable parent)
//     - inserts ONE family + parents + students + enrollment in a txn
//
//   createMissingEnrolledFamilies(schoolId)
//     - the cron entry point: finds every "Enrolled"-stage opportunity
//       whose contact has no family yet, and creates it. Gated to LIVE
//       (billing_active) import-managed schools so it only fires for DGM.
//
// What it does NOT do: create tuition invoices. Billing is a separate,
// deliberate step (Start an Enrollment / the tuition plan). This only gives
// the family a portal so the office can email them the login link.

import { withTransaction, query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { getContact } from '@/lib/ghl/contacts';
import { loadSchoolFieldSchema, type SchoolFieldSchema } from './schema-loader';
import { pipelineStageToFunnelStatus } from './pipeline-stage-map';
import {
  fetchFieldSchema,
  mapContactToFamily,
  insertOneFamily,
  type FieldSchema,
} from './run-ghl-sync';

export interface CreateResult {
  created: boolean;
  reason?: string;
  family_id?: string;
  parent_id?: string;
  students?: number;
}

interface SyncCtx {
  client: GhlClient;
  config: SchoolFieldSchema;
  schema: FieldSchema;
}

// Load the GHL client + field schema + school config once. Fetching the
// field schema is a GHL API round-trip, so callers that process many
// contacts (createMissingEnrolledFamilies) load it once and pass it in.
async function loadCtx(schoolId: string): Promise<SyncCtx> {
  const client = await loadGhlClient(schoolId);
  const config = await loadSchoolFieldSchema(schoolId);
  const schema = await fetchFieldSchema(client);
  return { client, config, schema };
}

export async function createFamilyFromContact(
  schoolId: string,
  contactId: string,
  ctx?: SyncCtx,
): Promise<CreateResult> {
  if (!contactId) return { created: false, reason: 'no_contact_id' };

  // Idempotency: a parent already linked to this GHL contact means the
  // family (and its portal) already exists. Never double-create.
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM parents WHERE school_id = $1 AND ghl_contact_id = $2 LIMIT 1`,
    [schoolId, contactId],
  );
  if (existing[0]) return { created: false, reason: 'already_exists', parent_id: existing[0].id };

  const c = ctx ?? (await loadCtx(schoolId));
  const contact = await getContact(c.client, contactId);
  if (!contact) return { created: false, reason: 'contact_not_found' };

  const fam = mapContactToFamily(contact, c.schema, c.config, [], {
    requireHousehold: false,
    forceEnrolled: true,
  });
  if (!fam) return { created: false, reason: 'could_not_map_contact' };

  // The primary parent MUST have an email — that's the magic-link login key.
  // Without it the portal is useless, so we skip and surface the reason so
  // the office can fix the email on the GHL contact, rather than silently
  // creating a family nobody can log into.
  const primary = fam.parents.find((p) => p.is_primary);
  if (!primary || !primary.email) {
    return { created: false, reason: 'primary_parent_missing_email' };
  }

  const res = await withTransaction((q) => insertOneFamily(q, schoolId, fam));

  const { rows: pr } = await query<{ id: string }>(
    `SELECT id FROM parents
      WHERE school_id = $1 AND ghl_contact_id = $2 AND is_primary = true LIMIT 1`,
    [schoolId, contactId],
  );

  return {
    created: true,
    family_id: res.familyId,
    parent_id: pr[0]?.id,
    students: res.studentsCreated,
  };
}

export interface EnrollSweepResult {
  ran: boolean;
  reason?: string;
  checked: number;
  created: number;
  skipped: number;
  errors: number;
  details: string[];
}

// Cron entry point. Idempotent + safe to run every tick. Only fires for a
// LIVE (billing_active) attributes_only school — i.e. DGM today. Snapshot
// schools already auto-create families on their full sync, so they're
// intentionally excluded (the cron passes attributes-only schools here).
export async function createMissingEnrolledFamilies(
  schoolId: string,
): Promise<EnrollSweepResult> {
  // Gate: only live, billing-active schools. Keeps the trigger from
  // surprising a not-yet-launched import-managed school.
  const { rows: cfg } = await query<{ active: boolean }>(
    `SELECT COALESCE(billing_active, false) AS active
       FROM school_payment_config WHERE school_id = $1`,
    [schoolId],
  );
  if (!cfg[0]?.active) {
    return { ran: false, reason: 'not_billing_active', checked: 0, created: 0, skipped: 0, errors: 0, details: [] };
  }

  // Candidate contacts: have an opportunity at an "Enrolled"-mapped stage and
  // no parent row yet. Stage names are school-specific free text, so we pull
  // candidates (no family yet) and filter the stage in JS with the same
  // mapper the admissions funnel uses.
  const { rows: opps } = await query<{ ghl_contact_id: string; stage_name: string | null }>(
    `SELECT DISTINCT o.ghl_contact_id, o.stage_name
       FROM ghl_opportunities o
      WHERE o.school_id = $1
        AND o.ghl_contact_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM parents p
           WHERE p.school_id = $1 AND p.ghl_contact_id = o.ghl_contact_id
        )`,
    [schoolId],
  );

  const enrolledContactIds = new Set<string>();
  for (const o of opps) {
    if (pipelineStageToFunnelStatus(o.stage_name ?? '') === 'enrolled') {
      enrolledContactIds.add(o.ghl_contact_id);
    }
  }

  const details: string[] = [];
  let created = 0;
  let skipped = 0;
  let errors = 0;

  if (enrolledContactIds.size === 0) {
    return { ran: true, checked: 0, created: 0, skipped: 0, errors: 0, details: [] };
  }

  const ctx = await loadCtx(schoolId);
  for (const contactId of enrolledContactIds) {
    try {
      const r = await createFamilyFromContact(schoolId, contactId, ctx);
      if (r.created) {
        created++;
        details.push(`created ${contactId} → family ${r.family_id} (${r.students ?? 0} students)`);
      } else {
        skipped++;
        details.push(`skipped ${contactId}: ${r.reason}`);
      }
    } catch (e) {
      errors++;
      details.push(`error ${contactId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { ran: true, checked: enrolledContactIds.size, created, skipped, errors, details };
}
