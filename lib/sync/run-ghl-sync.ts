// One-shot sync: pulls all of a school's GHL contacts (one per family),
// maps them into family-graph rows (families, parents, students,
// enrollments, classrooms), and writes them in a single transaction.
//
// Snapshot semantics: the school's existing family-graph rows are deleted
// first (cascade through the FK chain), then re-inserted from GHL. This
// means the GHL data is treated as the source of truth — any direct edits
// in family-graph that aren't represented in GHL will be lost on the next
// sync. That tradeoff is correct for v1: GHL is where the operator
// edits, family-graph is the read model the platform queries.
//
// Idempotent. Re-runnable. Single SQL transaction so partial failures
// don't leave the school in a half-synced state.

import { withTransaction, query } from '@/lib/db';
import { loadGhlClient, type GhlClient } from '@/lib/ghl/client';
import { searchContacts, type GhlContact } from '@/lib/ghl/contacts';
import {
  fetchPipelines,
  fetchAllOpportunities,
  buildStageLookup,
  indexOpportunitiesByContact,
  pickPrimaryOpportunity,
  type StageInfo,
  type Opportunity,
} from '@/lib/ghl/pipelines';
import { pipelineStageToFunnelStatus } from './pipeline-stage-map';
import { loadSchoolFieldSchema, type SchoolFieldSchema } from './schema-loader';
import { studentFieldKey, STUDENT_FIELDS as CANONICAL_STUDENT } from './desert-garden-config';
import { parseStudentSlotKey, studentSlotKeyCandidates } from './slot-keys';

// ----- GHL field-schema helpers ---------------------------------------------

interface GhlFieldDef {
  id: string;
  name?: string;
  fieldKey?: string;
  key?: string;
}

export type FieldSchema = Map<string, string>; // normalized fieldKey → field id

export async function fetchFieldSchema(client: GhlClient): Promise<FieldSchema> {
  const { data } = await client.axios.get<{ customFields?: GhlFieldDef[] }>(
    `/locations/${client.locationId}/customFields`
  );
  const map: FieldSchema = new Map();
  for (const f of data.customFields ?? []) {
    const raw = f.fieldKey ?? f.key;
    if (!raw || !f.id) continue;
    const normalized = raw.startsWith('contact.') ? raw.slice('contact.'.length) : raw;
    map.set(normalized, f.id);
  }
  return map;
}

function getField(contact: GhlContact, key: string, schema: FieldSchema): string {
  const id = schema.get(key);
  if (!id) return '';
  const f = contact.customFields?.find((cf) => cf.id === id);
  if (!f || f.value === null || f.value === undefined) return '';
  if (Array.isArray(f.value)) return f.value.length > 0 ? f.value.join(', ') : '';
  return String(f.value).trim();
}

function getStudentField(
  contact: GhlContact,
  schema: FieldSchema,
  slot: number,
  base: string,
): string {
  // Try every key form this slot could use (slot 1 may be `student_<base>`
  // OR `student_1_<base>` depending on the school) — a location only uses
  // one, so this stays school-agnostic.
  for (const key of studentSlotKeyCandidates(slot, base)) {
    const v = getField(contact, key, schema);
    if (v) return v;
  }
  return '';
}

// Capture every non-empty custom field on the contact that's scoped to a
// given student slot, regardless of whether it's in the school's
// configured STUDENT_FIELDS. This is the school-agnostic catch-all so
// schools with naming that doesn't match our DG-derived template (e.g.
// Arbor's `student_1_date_of_birth`, `intended_start_date`, `age`) still
// get their data into the dashboard. The accordion's "Other" bucket
// renders anything we don't have a curated label for.
//
// Slot scoping is based on what we can detect in the field key:
//   - `student_<N>_<rest>`  → slot N (so `student_1_date_of_birth` is slot 1,
//                             `student_2_age` is slot 2)
//   - `student_<rest>`      → slot 1 (DG-style: name has no slot number)
//   - everything else       → slot 1 only (contact-level / unprefixed)
//
// We also skip parent / family-level fields, since they belong to the
// parent row not the student. Stripped-of-prefix keys are used so the
// downstream bucket logic in the widget is uniform across schools.
function captureAllContactFieldsForSlot(
  contact: GhlContact,
  schema: FieldSchema,
  slot: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const idToKey = new Map<string, string>();
  for (const [key, id] of schema.entries()) idToKey.set(id, key);

  for (const cf of contact.customFields ?? []) {
    const key = idToKey.get(cf.id);
    if (!key) continue;
    // Normalize value to non-empty string
    let value: string;
    if (cf.value === null || cf.value === undefined) continue;
    if (Array.isArray(cf.value)) {
      if (cf.value.length === 0) continue;
      value = cf.value.join(', ');
    } else {
      value = String(cf.value).trim();
    }
    if (!value) continue;

    // Parent / family-level fields don't belong on the student
    if (key.startsWith('parent_') || key.startsWith('parent2_')) continue;
    if (key === 'household_id' || key === 'household_phone' || key === 'parents_combined') continue;

    // Determine which slot this field belongs to (and what its bare name
    // is) via the shared school-agnostic parser. Unprefixed contact-level
    // fields are slot-1 by convention.
    const parsed = parseStudentSlotKey(key);
    const belongsToSlot = parsed ? parsed.slot : 1;
    const display = parsed ? parsed.base : key;
    if (belongsToSlot !== slot) continue;
    if (!display || display in out) continue;
    out[display] = value;
  }
  return out;
}

// Strip empty / null / undefined values from a metadata object. Avoids
// polluting student.metadata with 40+ empty DG-template keys for
// schools that don't have most of those fields populated. Preserves
// nested objects (e.g. form_completion) as-is.
function pruneEmptyMetadata<T extends Record<string, unknown>>(md: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out as T;
}

// Map GHL's free-text enrollment status strings to family-graph's
// constrained enum (inquiry, tour_scheduled, application_submitted,
// accepted, enrolled, waitlisted, withdrawn, declined).
// Unknown values fall back to 'enrolled' on the assumption that any
// contact with student data + household_id is at minimum enrolled —
// pre-enrollment families typically don't have student rows yet.
export function normalizeEnrollmentStatus(raw: string, warnings: string[]): string {
  const v = raw.trim().toLowerCase();
  if (!v) return 'enrolled';
  // Direct match (already normalized)
  const allowed = new Set([
    'inquiry', 'tour_scheduled', 'application_submitted',
    'accepted', 'pending', 'enrolled', 'waitlisted', 'withdrawn', 'declined',
  ]);
  if (allowed.has(v)) return v;
  // GHL freetext variants
  const collapsed = v.replace(/[\s_-]+/g, ' ');
  if (collapsed === 'enrolled' || collapsed === 'enrolled not started' || collapsed === 'currently enrolled') return 'enrolled';
  // "Pending" — sent the enrollment agreement, awaiting completion/signature.
  if (collapsed === 'pending' || collapsed === 'pending enrollment' || collapsed === 'enrollment pending' || collapsed === 'pending opportunities') return 'pending';
  if (collapsed === 'accepted' || collapsed === 'admitted') return 'accepted';
  if (collapsed === 'waitlist' || collapsed === 'waitlisted') return 'waitlisted';
  if (collapsed === 'withdrawn' || collapsed === 'withdrew' || collapsed === 'graduated') return 'withdrawn';
  if (collapsed === 'inquiry' || collapsed === 'inquired' || collapsed === 'lead') return 'inquiry';
  if (collapsed === 'tour scheduled' || collapsed === 'tour') return 'tour_scheduled';
  if (collapsed === 'application submitted' || collapsed === 'applied') return 'application_submitted';
  if (collapsed === 'declined' || collapsed === 'rejected' || collapsed === 'denied') return 'declined';
  warnings.push(`unknown enrollment status "${raw}" — defaulted to "enrolled"`);
  return 'enrolled';
}

// Date normalization: GHL stores dates as ISO strings or ms epochs;
// Postgres `date` accepts YYYY-MM-DD. Returns null on anything unparseable.
function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  // Pure number → epoch ms
  if (/^-?\d+$/.test(raw)) {
    const d = new Date(Number(raw));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ----- Mapper ---------------------------------------------------------------

export interface MappedFamily {
  display_name: string;
  notes: string | null;
  status: string;
  parents: MappedParent[];
  students: MappedStudent[];
}

// Options for mapContactToFamily. Defaults preserve the snapshot-sync
// behavior; the enrollment trigger (createFamilyFromContact) overrides them.
export interface MapContactOpts {
  // Require a household_id custom field to treat the contact as a family.
  // Default true (snapshot sync skips non-roster contacts). The enroll
  // trigger sets false — a freshly-enrolled prospect may not have one yet.
  requireHousehold?: boolean;
  // Force every student's enrollment to 'enrolled' and allow a
  // parent-only family (so the parent can log in immediately). Used by the
  // enroll trigger.
  forceEnrolled?: boolean;
}

interface MappedParent {
  ghl_contact_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  role: string;
}

interface MappedStudent {
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string;
  classroom_name: string | null;
  grade_level: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string;
  enrolled_at: string | null;
  metadata: Record<string, unknown>;
}

interface SchoolFormDef {
  completion_field_key: string;
  per_student: boolean;
}

export function mapContactToFamily(
  contact: GhlContact,
  schema: FieldSchema,
  config: SchoolFieldSchema,
  forms: SchoolFormDef[] = [],
  opts: MapContactOpts = {},
): MappedFamily | null {
  const FAMILY = config.family_fields;
  const PARENT2 = config.parent2_fields;
  const STUDENT = config.student_fields;

  // Skip contacts without the configured household-id field — they're not
  // family-roster contacts. (Field key configurable per school.) The enroll
  // trigger passes requireHousehold:false so a just-enrolled contact that
  // hasn't been assigned a household_id yet still becomes a family.
  const requireHousehold = opts.requireHousehold !== false;
  const householdIdKey = FAMILY.householdId;
  if (requireHousehold && !householdIdKey) return null;
  const householdId = householdIdKey ? getField(contact, householdIdKey, schema) : '';
  if (requireHousehold && !householdId) return null;

  const parent1FirstName = (contact.firstName ?? '').trim();
  const parent1LastName = (contact.lastName ?? '').trim();

  const parents: MappedParent[] = [
    {
      ghl_contact_id: contact.id,
      first_name: parent1FirstName,
      last_name: parent1LastName,
      email: contact.email?.trim() || null,
      phone: contact.phone?.trim() || null,
      is_primary: true,
      role: 'parent',
    },
  ];

  // Parent 2 — only if at least one P2 field is populated AND configured.
  const p2First = PARENT2.firstName ? getField(contact, PARENT2.firstName, schema) : '';
  const p2Last = PARENT2.lastName ? getField(contact, PARENT2.lastName, schema) : '';
  const p2Email = PARENT2.email ? getField(contact, PARENT2.email, schema) : '';
  const p2Phone = PARENT2.phone ? getField(contact, PARENT2.phone, schema) : '';
  if (p2First || p2Last || p2Email || p2Phone) {
    parents.push({
      ghl_contact_id: null,
      first_name: p2First,
      last_name: p2Last,
      email: p2Email || null,
      phone: p2Phone || null,
      is_primary: false,
      role: 'parent',
    });
  }

  // Students: scan up to max_student_slots, include any with a non-empty
  // first name. All field references go through the per-school config.
  const students: MappedStudent[] = [];
  for (let slot = 1; slot <= config.max_student_slots; slot++) {
    if (!STUDENT.firstName) break; // schema didn't configure students at all
    const firstName = getStudentField(contact, schema, slot, STUDENT.firstName);
    if (!firstName) continue;
    const lastName = (STUDENT.lastName ? getStudentField(contact, schema, slot, STUDENT.lastName) : '') || parent1LastName;
    const preferredName = STUDENT.preferredName ? getStudentField(contact, schema, slot, STUDENT.preferredName) : '';
    const dob = STUDENT.birthDate ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.birthDate)) : null;
    const gender = STUDENT.gender ? getStudentField(contact, schema, slot, STUDENT.gender) : '';
    const program = STUDENT.program ? getStudentField(contact, schema, slot, STUDENT.program) : '';
    const homeroom = STUDENT.homeroom ? getStudentField(contact, schema, slot, STUDENT.homeroom) : '';
    const gradeLevel = STUDENT.gradeLevel ? getStudentField(contact, schema, slot, STUDENT.gradeLevel) : '';
    const enrollmentStatus = STUDENT.enrollmentStatus ? getStudentField(contact, schema, slot, STUDENT.enrollmentStatus) : '';
    const initialStart = STUDENT.initialStartDate
      ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.initialStartDate))
      : null;
    const currentStart = STUDENT.currentYearStartDate
      ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.currentYearStartDate))
      : null;
    const iep = STUDENT.iep ? getStudentField(contact, schema, slot, STUDENT.iep) : '';
    const five04 = STUDENT.fivelOFourPlan ? getStudentField(contact, schema, slot, STUDENT.fivelOFourPlan) : '';
    const dailySchedule = STUDENT.dailySchedule ? getStudentField(contact, schema, slot, STUDENT.dailySchedule) : '';
    const leadTeacher = STUDENT.leadTeacher ? getStudentField(contact, schema, slot, STUDENT.leadTeacher) : '';
    const allergy = STUDENT.allergy ? getStudentField(contact, schema, slot, STUDENT.allergy) : '';

    // School-configured form completion fields. Per-student forms use the
    // slot prefix; family-level forms read the same key for every slot.
    const formCompletion: Record<string, string> = {};
    for (const form of forms) {
      const key = form.per_student
        ? studentFieldKey(slot, form.completion_field_key)
        : form.completion_field_key;
      const value = getField(contact, key, schema);
      formCompletion[form.completion_field_key] = value;
    }

    // Capture EVERY student-scoped field configured for this school into
    // metadata, keyed by the snake_case GHL field key. Downstream widgets
    // (FinanceDashboard, RostersHub) read from here without needing to
    // know which fields exist per school.
    const rawStudentFields: Record<string, string> = {};
    for (const [role, baseKey] of Object.entries(STUDENT)) {
      if (!baseKey) continue;
      const v = getStudentField(contact, schema, slot, baseKey);
      rawStudentFields[baseKey] = v;
      // Also write under the canonical role key so school-agnostic widgets
      // (FinanceDashboard etc.) find the value regardless of what this
      // location named the field — e.g. a school that calls tuition
      // `annual_tuition` still populates metadata.tuition_fee.
      const canonical = CANONICAL_STUDENT[role as keyof typeof CANONICAL_STUDENT];
      if (canonical && canonical !== baseKey) rawStudentFields[canonical] = v;
    }
    // Plus EVERY non-empty custom field on the contact that belongs to
    // this slot — picks up school-specific fields not in our DG template.
    const allContactFields = captureAllContactFieldsForSlot(contact, schema, slot);

    const classroomName = (homeroom || program || '').trim() || null;

    students.push({
      first_name: firstName,
      last_name: lastName,
      preferred_name: preferredName || null,
      date_of_birth: dob,
      gender: gender || null,
      enrollment_status: opts.forceEnrolled ? 'enrolled' : (enrollmentStatus || 'unknown'),
      classroom_name: classroomName,
      grade_level: gradeLevel || null,
      lead_teacher_name: leadTeacher || null,
      schedule: dailySchedule || null,
      academic_year: config.default_academic_year,
      enrolled_at: currentStart ?? initialStart,
      metadata: pruneEmptyMetadata({
        // Catch-all underneath: school-agnostic capture of every
        // populated custom field. Curated/templated keys above can
        // override since they come last in the spread.
        ...allContactFields,
        ...rawStudentFields,
        ghl_slot: slot,
        ghl_contact_id: contact.id,
        program,
        homeroom,
        iep,
        five04_plan: five04,
        initial_start_date: initialStart,
        household_id: householdId,
        allergy,
        form_completion: formCompletion,
      }),
    });
  }

  if (students.length === 0) {
    // Family has no students. Default behavior is to skip — inquiry-stage
    // families belong in the inquiry pipeline, not the family graph. But
    // schools that import a roster of parents-only (no student data yet)
    // can flip the allow_parent_only_families flag on their
    // school_field_schemas row, and we keep the family as a
    // parent-and-household record. Dashboards will show 0 students until
    // the school backfills student data on the contact.
    // The enroll trigger (forceEnrolled) also allows parent-only so the
    // parent can log in the moment they're enrolled — student rows backfill
    // from GHL afterward.
    if (!config.allow_parent_only_families && !opts.forceEnrolled) return null;
  }

  const displayName = (() => {
    const lastName = parent1LastName || students[0]?.last_name;
    return lastName ? `${lastName} Family` : `${parent1FirstName} ${parent1LastName}`.trim() || 'Unnamed';
  })();

  return {
    display_name: displayName,
    notes: null,
    status: 'active',
    parents,
    students,
  };
}

// ----- Phase 2: pipeline opportunities → prospective families ---------------
//
// For each pipeline opportunity attached to a contact that DIDN'T have
// household_id (i.e. wasn't synced as an enrolled family in Phase 1),
// build a "prospective" family with one placeholder student and an
// enrollment row at the mapped pipeline stage. This is what makes the
// admissions funnel show inquiry/tour/application/accepted counts —
// without it, the funnel only shows already-enrolled families.

interface ProspectiveFamilyInput {
  contact: GhlContact;
  opp: Opportunity;
  stage: StageInfo;
  funnelStatus: string;
}

function buildProspectiveFamily(
  input: ProspectiveFamilyInput,
  warnings: string[],
  config: SchoolFieldSchema,
  schema: FieldSchema,
): MappedFamily {
  const { contact, opp, stage, funnelStatus } = input;
  const parentFirstName = (contact.firstName ?? '').trim();
  const parentLastName = (contact.lastName ?? '').trim();

  // Parent 2 — pipeline-prospective contacts often still have P2 fields
  // populated (the contact represents the family, and the school filled in
  // both parents during inquiry). Extract using the same field-key lookup
  // Phase 1 uses, so schools without a household_id field still get P2s.
  const PARENT2 = config.parent2_fields;
  const p2First = PARENT2.firstName ? getField(contact, PARENT2.firstName, schema) : '';
  const p2Last = PARENT2.lastName ? getField(contact, PARENT2.lastName, schema) : '';
  const p2Email = PARENT2.email ? getField(contact, PARENT2.email, schema) : '';
  const p2Phone = PARENT2.phone ? getField(contact, PARENT2.phone, schema) : '';

  // Best-effort student name extraction. Many schools name the opportunity
  // after the prospective student ("Jane Smith - Fall 2026") — try to
  // strip the trailing year/term and use the rest. Fallback: parent's
  // last name + "(prospective)".
  let studentFirstName = '';
  let studentLastName = parentLastName;
  if (opp.name) {
    // Strip common suffixes like " - 2026", " Fall 2026", " (Inquiry)"
    const cleaned = opp.name
      .replace(/\s*[-–—]\s*(fall|spring|summer|winter)?\s*\d{4}([-/]\d{2,4})?\s*$/i, '')
      .replace(/\s*\((inquiry|tour|application|prospective).*\)\s*$/i, '')
      .trim();
    const parts = cleaned.split(/\s+/);
    if (parts.length >= 2) {
      studentFirstName = parts[0];
      studentLastName = parts.slice(1).join(' ');
    } else if (parts.length === 1 && parts[0]) {
      studentFirstName = parts[0];
    }
  }
  if (!studentFirstName) {
    studentFirstName = `${parentFirstName} (prospective)`.trim() || 'Prospective';
  }

  // Pick the best last name we can find so the family is recognizable in
  // the Family Hub. Priority: parent last → student last (from opp name) →
  // parent first → student first → 'Prospective'. Without this, schools
  // with sparse parent data ended up with display_name = "(prospective)"
  // (operator-precedence bug — the expression
  // `${parentFirstName} (prospective)`.trim() always resolves truthy).
  const displayName = (() => {
    const surname = parentLastName || studentLastName || '';
    if (surname) return `${surname} Family (prospective)`;
    const givenName = parentFirstName || studentFirstName || '';
    if (givenName) return `${givenName} (prospective)`;
    return 'Prospective Family';
  })();

  return {
    display_name: displayName,
    notes: null,
    status: 'active', // family.status enum doesn't include 'prospective'
    parents: [
      {
        ghl_contact_id: contact.id,
        first_name: parentFirstName,
        last_name: parentLastName,
        email: contact.email?.trim() || null,
        phone: contact.phone?.trim() || null,
        is_primary: true,
        role: 'parent',
      },
      ...(p2First || p2Last || p2Email || p2Phone
        ? [{
            ghl_contact_id: null,
            first_name: p2First,
            last_name: p2Last,
            email: p2Email || null,
            phone: p2Phone || null,
            is_primary: false,
            role: 'parent',
          } as MappedParent]
        : []),
    ],
    students: buildProspectiveStudents({
      contact, opp, stage, funnelStatus, config, schema,
      fallbackFirstName: studentFirstName,
      fallbackLastName: studentLastName,
    }),
  };
  void warnings; // reserved for future per-opp warnings
}

// Build the student rows for a Phase-2 prospective family. Phase 1 reads
// every configured student field per slot; Phase 2 used to just create a
// single placeholder with no detail. This unifies the two — if the
// contact has student custom fields filled in (Shrewsbury, Arbor, etc.
// schools that DON'T use household_id but DO use slotted student
// fields), we get the same student data Phase 1 would have captured.
//
// Slot 1 is always emitted (using the opp-name fallback when slot 1
// fields are empty). Slots 2+ are emitted only when the slot has at
// least one populated field (first_name + last_name + DOB) so we don't
// create empty placeholders.
function buildProspectiveStudents(args: {
  contact: GhlContact;
  opp: Opportunity;
  stage: StageInfo;
  funnelStatus: string;
  config: SchoolFieldSchema;
  schema: FieldSchema;
  fallbackFirstName: string;
  fallbackLastName: string;
}): MappedStudent[] {
  const { contact, opp, stage, funnelStatus, config, schema, fallbackFirstName, fallbackLastName } = args;
  const STUDENT = config.student_fields;
  const out: MappedStudent[] = [];
  for (let slot = 1; slot <= config.max_student_slots; slot++) {
    const firstName = STUDENT.firstName
      ? getStudentField(contact, schema, slot, STUDENT.firstName)
      : '';
    const lastName = STUDENT.lastName
      ? getStudentField(contact, schema, slot, STUDENT.lastName)
      : '';
    // Capture every populated field on the contact scoped to this slot.
    // We do this BEFORE the templated DOB read so we can use the
    // catch-all as a fallback when the school's field name doesn't
    // match the DG template (e.g. Arbor's `student_1_date_of_birth`).
    const allContactFields = captureAllContactFieldsForSlot(contact, schema, slot);
    const dobTemplated = STUDENT.birthDate
      ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.birthDate))
      : null;
    const dobCatchall = allContactFields.date_of_birth || allContactFields.birth_date || '';
    const dob = dobTemplated ?? (dobCatchall ? normalizeDate(dobCatchall) : null);
    // Slot 1: always include (use opp-name fallback if blank).
    // Slots 2+: skip unless something is populated.
    const hasData = !!(firstName || lastName || dob || Object.keys(allContactFields).length > 0);
    if (slot > 1 && !hasData) continue;

    const effectiveFirst = firstName || (slot === 1 ? fallbackFirstName : '');
    const effectiveLast = lastName || (slot === 1 ? fallbackLastName : '');
    if (!effectiveFirst && !effectiveLast) continue; // nothing usable

    // Pull every student field configured for this school into metadata,
    // same as Phase 1 — downstream widgets read by snake_case key.
    const rawStudentFields: Record<string, string> = {};
    for (const [role, baseKey] of Object.entries(STUDENT)) {
      if (!baseKey) continue;
      const v = getStudentField(contact, schema, slot, baseKey);
      rawStudentFields[baseKey] = v;
      // Also write under the canonical role key so school-agnostic widgets
      // (FinanceDashboard etc.) find the value regardless of what this
      // location named the field — e.g. a school that calls tuition
      // `annual_tuition` still populates metadata.tuition_fee.
      const canonical = CANONICAL_STUDENT[role as keyof typeof CANONICAL_STUDENT];
      if (canonical && canonical !== baseKey) rawStudentFields[canonical] = v;
    }

    const program = STUDENT.program ? getStudentField(contact, schema, slot, STUDENT.program) : '';
    const homeroom = STUDENT.homeroom ? getStudentField(contact, schema, slot, STUDENT.homeroom) : '';
    const gradeLevel = STUDENT.gradeLevel ? getStudentField(contact, schema, slot, STUDENT.gradeLevel) : '';
    const enrollmentStatus = STUDENT.enrollmentStatus ? getStudentField(contact, schema, slot, STUDENT.enrollmentStatus) : '';
    const dailySchedule = STUDENT.dailySchedule ? getStudentField(contact, schema, slot, STUDENT.dailySchedule) : '';
    const leadTeacher = STUDENT.leadTeacher ? getStudentField(contact, schema, slot, STUDENT.leadTeacher) : '';
    const initialStart = STUDENT.initialStartDate
      ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.initialStartDate))
      : null;
    const currentStart = STUDENT.currentYearStartDate
      ? normalizeDate(getStudentField(contact, schema, slot, STUDENT.currentYearStartDate))
      : null;
    const classroomName = (homeroom || program || '').trim() || null;

    out.push({
      first_name: effectiveFirst,
      last_name: effectiveLast,
      preferred_name: null,
      date_of_birth: dob,
      gender: STUDENT.gender ? getStudentField(contact, schema, slot, STUDENT.gender) || null : null,
      // If the contact's own status field has a value, prefer it; else use the funnel status.
      enrollment_status: enrollmentStatus || funnelStatus,
      classroom_name: classroomName,
      grade_level: gradeLevel || null,
      lead_teacher_name: leadTeacher || null,
      schedule: dailySchedule || null,
      academic_year: config.default_academic_year,
      enrolled_at: currentStart ?? initialStart,
      metadata: pruneEmptyMetadata({
        // Catch-all underneath; curated/templated values above can
        // override since they come last in the spread.
        ...allContactFields,
        ...rawStudentFields,
        prospective: true,
        ghl_slot: slot,
        ghl_contact_id: contact.id,
        ghl_opportunity_id: opp.id,
        ghl_pipeline_id: opp.pipelineId,
        ghl_pipeline_name: stage.pipelineName,
        ghl_stage_id: opp.pipelineStageId,
        ghl_stage_name: stage.stageName,
        opp_status: opp.status,
        opp_value: opp.monetaryValue ?? null,
        last_stage_change: opp.lastStageChangeAt ?? null,
        program,
        homeroom,
        initial_start_date: initialStart,
      }),
    });
  }
  return out;
}

// ----- Orchestrator ---------------------------------------------------------

export interface SyncResult {
  ghl_contacts_scanned: number;
  ghl_contacts_with_household_id: number;
  pipelines_scanned: number;
  opportunities_scanned: number;
  prospective_families_created: number;
  families_created: number;
  parents_created: number;
  students_created: number;
  enrollments_created: number;
  classrooms_created: number;
  p2_contact_ids_carried_forward: number;
  warnings: string[];
}

export async function runGhlSync(schoolId: string): Promise<SyncResult> {
  const client = await loadGhlClient(schoolId);
  const config = await loadSchoolFieldSchema(schoolId);
  const schema = await fetchFieldSchema(client);
  const allContacts = await searchContacts({ client, pageLimit: 100, maxPages: 50 });

  // Load this school's configured forms so the sync can capture each
  // form's completion value into student.metadata.form_completion. The
  // DocumentTracker widget reads from there.
  const { rows: formRows } = await import('@/lib/db').then((m) => m.query<{
    completion_field_key: string;
    per_student: boolean;
  }>(
    `SELECT completion_field_key, per_student
     FROM school_forms WHERE school_id = $1 AND is_active = true`,
    [schoolId],
  ));
  const formDefs: SchoolFormDef[] = formRows;

  const mapped: MappedFamily[] = [];
  let withHouseholdId = 0;
  const enrolledContactIds = new Set<string>();
  // Only GATE on household_id for schools that actually use it to mark which
  // contacts are roster families. Schools with no household field model one
  // contact = one family (e.g. a fresh per-family import), so every contact
  // that carries student data becomes a family — driven purely by what the
  // location holds, nothing school-specific.
  const requireHousehold = !!config.family_fields?.householdId;
  // Per-school ROSTER TAG FILTER: for schools listed here, ONLY contacts carrying
  // one of these tags become roster families (Spruce Tree = the "2026-27 stms"
  // enrolling class + withdrawn). Contacts tagged "withdrawn" are kept but marked
  // withdrawn. Schools not listed are unaffected (data-driven as before).
  const ROSTER_TAG_FILTER: Record<string, string[]> = {
    '4aba0898-ec93-42ed-8e87-5374ca211738': ['2026-27 stms', 'withdrawn'], // Spruce Tree Montessori
  };
  const rosterTags = (ROSTER_TAG_FILTER[schoolId] ?? []).map((t) => t.toLowerCase());
  const tagsLower = (c: GhlContact) => (c.tags ?? []).map((t) => String(t).trim().toLowerCase());
  const passesRosterFilter = (c: GhlContact) => rosterTags.length === 0 || rosterTags.some((rt) => tagsLower(c).includes(rt));
  const isWithdrawn = (c: GhlContact) => tagsLower(c).includes('withdrawn');
  for (const c of allContacts) {
    if (!passesRosterFilter(c)) continue;
    const family = mapContactToFamily(c, schema, config, formDefs, { requireHousehold });
    if (family) {
      if (isWithdrawn(c)) for (const s of family.students) s.enrollment_status = 'withdrawn';
      withHouseholdId++;
      enrolledContactIds.add(c.id);
      mapped.push(family);
    }
  }

  const warnings: string[] = [];

  // PHASE 2: pipeline opportunities → prospective families.
  // Best-effort: pipeline fetch failures leave the funnel showing only
  // post-enrollment data, no hard error.
  let pipelines: Awaited<ReturnType<typeof fetchPipelines>> = [];
  let opps: Opportunity[] = [];
  try {
    pipelines = await fetchPipelines(client);
  } catch (err) {
    warnings.push(`fetchPipelines failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    opps = await fetchAllOpportunities(client);
  } catch (err) {
    warnings.push(`fetchAllOpportunities failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stageLookup = buildStageLookup(pipelines);
  const oppsByContact = indexOpportunitiesByContact(opps);
  const contactsById = new Map(allContacts.map((c) => [c.id, c]));

  let prospectiveCreated = 0;
  for (const [contactId, contactOpps] of oppsByContact) {
    if (enrolledContactIds.has(contactId)) continue; // Phase 1 already covered them
    const contact = contactsById.get(contactId);
    if (!contact) continue;
    if (!passesRosterFilter(contact)) continue; // roster tag gate applies to prospects too
    const primary = pickPrimaryOpportunity(contactOpps);
    if (!primary) continue;
    if (primary.status !== 'open') continue; // skip lost/won/abandoned for the funnel
    const stage = stageLookup.get(primary.pipelineStageId);
    if (!stage) {
      warnings.push(`opp ${primary.id}: unknown stageId ${primary.pipelineStageId}`);
      continue;
    }
    const funnelStatus = pipelineStageToFunnelStatus(stage.stageName);
    if (!funnelStatus) {
      warnings.push(`stage "${stage.stageName}" (pipeline "${stage.pipelineName}") didn't map to any funnel status`);
      continue;
    }
    mapped.push(buildProspectiveFamily(
      { contact, opp: primary, stage, funnelStatus },
      warnings,
      config,
      schema,
    ));
    prospectiveCreated++;
  }
  const result = await withTransaction(async (q) => {
    // Carry forward P2 ghl_contact_id across the snapshot. Once Parent 2 is
    // promoted to a standalone GHL contact, we don't want a subsequent sync
    // to clear the link just because the snapshot rebuilds rows. Index by
    // (P1 ghl_contact_id, lowercased P2 email) since that's the stable
    // identity across snapshots — both come from GHL and don't change.
    const { rows: existingP2 } = await q<{
      p1_ghl_contact_id: string;
      p2_email_lower: string;
      p2_ghl_contact_id: string;
    }>(
      `SELECT
         p1.ghl_contact_id           AS p1_ghl_contact_id,
         LOWER(p2.email)             AS p2_email_lower,
         p2.ghl_contact_id           AS p2_ghl_contact_id
       FROM parents p2
       JOIN parents p1
         ON p1.family_id = p2.family_id
        AND p1.school_id = p2.school_id
        AND p1.is_primary = true
       WHERE p2.school_id = $1
         AND p2.is_primary = false
         AND p2.ghl_contact_id IS NOT NULL
         AND p2.email IS NOT NULL AND p2.email <> ''
         AND p1.ghl_contact_id IS NOT NULL`,
      [schoolId],
    );
    const p2ContactIdCarryover = new Map<string, string>();
    for (const row of existingP2) {
      p2ContactIdCarryover.set(
        `${row.p1_ghl_contact_id}|${row.p2_email_lower}`,
        row.p2_ghl_contact_id,
      );
    }

    // Preserve row ids across the snapshot rebuild. The parent portal holds
    // references to these ids — the login session's family_id, a form's
    // submitted student_id, a submission's parent_id — so a plain
    // delete+reinsert (new ids every 15-min sync) breaks portal actions
    // ("student not in family", FK violations on submit). Capture the current
    // id for each STABLE identity now (family = primary parent's GHL contact;
    // parent = contact / family+email; student = contact+slot) and reuse it on
    // reinsert below, so the same contact keeps the same id sync to sync.
    const parentKey = (isPrimary: boolean, gc: string | null, p1gc: string | null, email: string | null): string | null => {
      if (isPrimary && gc) return `p:${gc}`;
      if (!isPrimary && p1gc && email) return `s:${p1gc}|${email.toLowerCase()}`;
      return null;
    };
    const reuseFamilyId = new Map<string, string>();
    const reuseParentId = new Map<string, string>();
    const reuseStudentId = new Map<string, string>();
    {
      const { rows: ef } = await q<{ family_id: string; gc: string | null }>(
        `SELECT family_id, ghl_contact_id AS gc FROM parents
          WHERE school_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL`, [schoolId]);
      for (const r of ef) if (r.gc) reuseFamilyId.set(r.gc, r.family_id);
      const { rows: ep } = await q<{ id: string; gc: string | null; email: string | null; is_primary: boolean; p1gc: string | null }>(
        `SELECT pa.id, pa.ghl_contact_id AS gc, pa.email, pa.is_primary,
                (SELECT pp.ghl_contact_id FROM parents pp
                  WHERE pp.family_id = pa.family_id AND pp.is_primary = true LIMIT 1) AS p1gc
           FROM parents pa WHERE pa.school_id = $1`, [schoolId]);
      for (const r of ep) { const k = parentKey(r.is_primary, r.gc, r.p1gc, r.email); if (k) reuseParentId.set(k, r.id); }
      const { rows: es } = await q<{ id: string; gc: string | null; slot: string | null }>(
        `SELECT id, metadata->>'ghl_contact_id' AS gc, metadata->>'ghl_slot' AS slot
           FROM students WHERE school_id = $1`, [schoolId]);
      for (const r of es) if (r.gc && r.slot) reuseStudentId.set(`${r.gc}|${r.slot}`, r.id);
    }

    // Preserve parent portal credentials across the DELETE+INSERT rebuild.
    // The re-insert below only carries synced (GHL) fields, so without this a
    // parent who created a portal password would lose it on every sync. IDs
    // are preserved (reuse maps above), so we stash by id now and restore
    // after the rebuild. ON COMMIT DROP keeps it scoped to this transaction.
    await q(
      `CREATE TEMP TABLE _pw_preserve ON COMMIT DROP AS
         SELECT id, password_hash, password_set_at
           FROM parents
          WHERE school_id = $1 AND password_hash IS NOT NULL`,
      [schoolId],
    );

    // Before the rebuild, stamp submitter_email onto any submission missing it,
    // from its current parent. If that parent (or the whole family) is later
    // removed from GHL, we null the dangling parent_id/family_id below — and the
    // `real_has_family_parent` check constraint requires a real submission keep
    // EITHER a family+parent OR a submitter_email. Backfilling the email now
    // preserves "who submitted" and lets the orphan cleanup satisfy the check.
    await q(
      `UPDATE portal_form_submissions sub
          SET submitter_email = p.email
         FROM parents p
        WHERE sub.parent_id = p.id AND sub.school_id = $1
          AND sub.submitter_email IS NULL AND p.email IS NOT NULL`,
      [schoolId],
    );

    // Snapshot semantics: blow away existing rows for this school.
    // Cascade order matters; do it explicitly even though FKs would handle it.
    await q('DELETE FROM enrollments WHERE school_id = $1', [schoolId]);
    await q('DELETE FROM students WHERE school_id = $1', [schoolId]);
    await q('DELETE FROM family_relationships WHERE school_id = $1', [schoolId]);
    await q('DELETE FROM parents WHERE school_id = $1', [schoolId]);
    await q('DELETE FROM families WHERE school_id = $1', [schoolId]);
    await q('DELETE FROM classrooms WHERE school_id = $1', [schoolId]);

    let p2ContactIdCarriedForward = 0;

    // Classroom upsert cache: name+academic_year → id
    const classroomCache = new Map<string, string>();

    let familiesCreated = 0;
    let parentsCreated = 0;
    let studentsCreated = 0;
    let enrollmentsCreated = 0;
    let classroomsCreated = 0;

    for (const fam of mapped) {
      // P1 contact id from this family (used to look up carryover for the
      // family's P2, and to preserve ids across the rebuild). Phase-1 /
      // Phase-2 both put P1 first and only one P1 per family, so this is
      // well-defined.
      const p1ContactId = fam.parents.find((p) => p.is_primary)?.ghl_contact_id ?? null;
      const keepFamilyId = p1ContactId ? reuseFamilyId.get(p1ContactId) : undefined;
      const { rows: famRows } = keepFamilyId
        ? await q<{ id: string }>(
            `INSERT INTO families (id, school_id, display_name, notes, status)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [keepFamilyId, schoolId, fam.display_name, fam.notes, fam.status])
        : await q<{ id: string }>(
            `INSERT INTO families (school_id, display_name, notes, status)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [schoolId, fam.display_name, fam.notes, fam.status]);
      const familyId = famRows[0].id;
      familiesCreated++;

      for (const p of fam.parents) {
        let effectiveContactId = p.ghl_contact_id;
        // P2 with email + P1 known → check carryover map
        if (!effectiveContactId && !p.is_primary && p.email && p1ContactId) {
          const carryKey = `${p1ContactId}|${p.email.toLowerCase()}`;
          const carry = p2ContactIdCarryover.get(carryKey);
          if (carry) {
            effectiveContactId = carry;
            p2ContactIdCarriedForward++;
          }
        }
        const pk = parentKey(p.is_primary, p.ghl_contact_id, p1ContactId, p.email);
        const keepParentId = pk ? reuseParentId.get(pk) : undefined;
        if (keepParentId) {
          await q(
            `INSERT INTO parents
               (id, family_id, school_id, ghl_contact_id, first_name, last_name,
                email, phone, role, is_primary, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')`,
            [keepParentId, familyId, schoolId, effectiveContactId,
             p.first_name, p.last_name, p.email, p.phone, p.role, p.is_primary],
          );
        } else {
          await q(
            `INSERT INTO parents
               (family_id, school_id, ghl_contact_id, first_name, last_name,
                email, phone, role, is_primary, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
            [familyId, schoolId, effectiveContactId,
             p.first_name, p.last_name, p.email, p.phone, p.role, p.is_primary],
          );
        }
        parentsCreated++;
      }

      for (const s of fam.students) {
        const sContact = String((s.metadata as Record<string, unknown>)?.ghl_contact_id ?? '') || p1ContactId || '';
        const sSlot = String((s.metadata as Record<string, unknown>)?.ghl_slot ?? '');
        const keepStudentId = (sContact && sSlot) ? reuseStudentId.get(`${sContact}|${sSlot}`) : undefined;
        const { rows: stuRows } = keepStudentId
          ? await q<{ id: string }>(
              `INSERT INTO students
                 (id, family_id, school_id, first_name, last_name, preferred_name,
                  date_of_birth, gender, status, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb)
               RETURNING id`,
              [keepStudentId, familyId, schoolId,
               s.first_name, s.last_name, s.preferred_name,
               s.date_of_birth, s.gender, JSON.stringify(s.metadata)])
          : await q<{ id: string }>(
              `INSERT INTO students
                 (family_id, school_id, first_name, last_name, preferred_name,
                  date_of_birth, gender, status, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb)
               RETURNING id`,
              [familyId, schoolId,
               s.first_name, s.last_name, s.preferred_name,
               s.date_of_birth, s.gender, JSON.stringify(s.metadata)]);
        const studentId = stuRows[0].id;
        studentsCreated++;

        // Resolve classroom (cache by name+year). Lead teacher comes from
        // the FIRST student we see in this classroom that has one set —
        // subsequent students in the same classroom don't overwrite it.
        // (For DG, every student in a classroom shares the same teacher;
        // for schools where they differ, "first wins" is good enough.)
        let classroomId: string | null = null;
        if (s.classroom_name) {
          const cacheKey = `${s.classroom_name}|${s.academic_year}`;
          classroomId = classroomCache.get(cacheKey) ?? null;
          if (!classroomId) {
            const { rows: cRows } = await q<{ id: string }>(
              `INSERT INTO classrooms (school_id, name, grade_level, academic_year, target_seats, lead_teacher_name)
               VALUES ($1, $2, $3, $4, 0, $5) RETURNING id`,
              [schoolId, s.classroom_name, s.grade_level, s.academic_year, s.lead_teacher_name],
            );
            classroomId = cRows[0].id;
            classroomCache.set(cacheKey, classroomId);
            classroomsCreated++;
          } else if (s.lead_teacher_name) {
            // Backfill teacher if classroom existed without one but this student has it
            await q(
              `UPDATE classrooms SET lead_teacher_name = $1
               WHERE id = $2 AND (lead_teacher_name IS NULL OR lead_teacher_name = '')`,
              [s.lead_teacher_name, classroomId],
            );
          }
        }

        const normalizedStatus = normalizeEnrollmentStatus(s.enrollment_status, warnings);
        await q(
          `INSERT INTO enrollments
             (student_id, school_id, classroom_id, academic_year, status, enrolled_at, schedule)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [studentId, schoolId, classroomId, s.academic_year, normalizedStatus, s.enrolled_at, s.schedule],
        );
        enrollmentsCreated++;
      }
    }

    // Restore preserved portal credentials onto the rebuilt parent rows,
    // matched by their preserved id. No-op when no parent had a password.
    await q(
      `UPDATE parents p
          SET password_hash = t.password_hash,
              password_set_at = t.password_set_at
         FROM _pw_preserve t
        WHERE p.id = t.id`,
    );

    // Robustness guard: a portal submission points at student / parent / family
    // rows by id. When one of those is removed from GHL (contact deleted, or a
    // slot's name fields cleared) the rebuild won't recreate that id — and the
    // DEFERRABLE-INITIALLY-DEFERRED FKs on portal_form_submissions would abort
    // the ENTIRE school's sync at COMMIT. Null the now-dangling links so a
    // single removed contact can't stall the whole sync. All three columns are
    // nullable; the submission's answers + signature stay intact, only the
    // pointer to the vanished row is cleared (correct — it no longer exists).
    // parent_uploads carries the same student FK, so guard it too.
    const nullOrphans = async (table: string, col: string, refTable: string) => {
      const res = await q(
        `UPDATE ${table} SET ${col} = NULL
          WHERE school_id = $1 AND ${col} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.id = ${table}.${col})`,
        [schoolId],
      );
      return res.rowCount ?? 0;
    };
    const cleared =
      (await nullOrphans('portal_form_submissions', 'student_id', 'students')) +
      (await nullOrphans('portal_form_submissions', 'parent_id', 'parents')) +
      (await nullOrphans('portal_form_submissions', 'family_id', 'families')) +
      (await nullOrphans('parent_uploads', 'student_id', 'students'));
    if (cleared > 0) warnings.push(`Cleared ${cleared} dangling portal link(s) whose contact left GHL.`);

    return {
      familiesCreated, parentsCreated, studentsCreated,
      enrollmentsCreated, classroomsCreated,
      p2ContactIdCarriedForward,
    };
  });

  return {
    ghl_contacts_scanned: allContacts.length,
    ghl_contacts_with_household_id: withHouseholdId,
    pipelines_scanned: pipelines.length,
    opportunities_scanned: opps.length,
    prospective_families_created: prospectiveCreated,
    families_created: result.familiesCreated,
    parents_created: result.parentsCreated,
    students_created: result.studentsCreated,
    enrollments_created: result.enrollmentsCreated,
    classrooms_created: result.classroomsCreated,
    p2_contact_ids_carried_forward: result.p2ContactIdCarriedForward,
    warnings,
  };
}

// ----- Single-family insert (non-destructive) --------------------------------
//
// Inserts ONE mapped family + its parents + students + enrollments, reusing
// an existing classroom (by name + academic year) rather than creating a
// duplicate. Unlike runGhlSync's loop, this does NOT delete anything — it's
// the additive path used by the enrollment trigger (createFamilyFromContact)
// to add a single newly-enrolled family without touching the rest of the
// import-managed roster. Caller is responsible for idempotency (don't call
// it twice for a contact that already has a parent row) and for wrapping it
// in a transaction.
type QueryFn = typeof query;

export async function insertOneFamily(
  q: QueryFn,
  schoolId: string,
  fam: MappedFamily,
): Promise<{ familyId: string; parentsCreated: number; studentsCreated: number; enrollmentsCreated: number }> {
  const warnings: string[] = [];
  const { rows: famRows } = await q<{ id: string }>(
    `INSERT INTO families (school_id, display_name, notes, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [schoolId, fam.display_name, fam.notes, fam.status],
  );
  const familyId = famRows[0].id;
  let parentsCreated = 0;
  let studentsCreated = 0;
  let enrollmentsCreated = 0;

  for (const p of fam.parents) {
    await q(
      `INSERT INTO parents
         (family_id, school_id, ghl_contact_id, first_name, last_name,
          email, phone, role, is_primary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')`,
      [familyId, schoolId, p.ghl_contact_id, p.first_name, p.last_name, p.email, p.phone, p.role, p.is_primary],
    );
    parentsCreated++;
  }

  for (const s of fam.students) {
    const { rows: stuRows } = await q<{ id: string }>(
      `INSERT INTO students
         (family_id, school_id, first_name, last_name, preferred_name,
          date_of_birth, gender, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb)
       RETURNING id`,
      [familyId, schoolId, s.first_name, s.last_name, s.preferred_name, s.date_of_birth, s.gender, JSON.stringify(s.metadata)],
    );
    const studentId = stuRows[0].id;
    studentsCreated++;

    // Reuse an existing classroom (non-destructive) or create it.
    let classroomId: string | null = null;
    if (s.classroom_name) {
      const { rows: ex } = await q<{ id: string }>(
        `SELECT id FROM classrooms WHERE school_id = $1 AND name = $2 AND academic_year = $3 LIMIT 1`,
        [schoolId, s.classroom_name, s.academic_year],
      );
      if (ex[0]) {
        classroomId = ex[0].id;
      } else {
        const { rows: cRows } = await q<{ id: string }>(
          `INSERT INTO classrooms (school_id, name, grade_level, academic_year, target_seats, lead_teacher_name)
           VALUES ($1, $2, $3, $4, 0, $5) RETURNING id`,
          [schoolId, s.classroom_name, s.grade_level, s.academic_year, s.lead_teacher_name],
        );
        classroomId = cRows[0].id;
      }
    }

    const normalizedStatus = normalizeEnrollmentStatus(s.enrollment_status, warnings);
    await q(
      `INSERT INTO enrollments
         (student_id, school_id, classroom_id, academic_year, status, enrolled_at, schedule)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId, schoolId, classroomId, s.academic_year, normalizedStatus, s.enrolled_at, s.schedule],
    );
    enrollmentsCreated++;
  }

  return { familyId, parentsCreated, studentsCreated, enrollmentsCreated };
}
