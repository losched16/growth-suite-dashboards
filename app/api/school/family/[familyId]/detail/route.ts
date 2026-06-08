// GET /api/school/family/{familyId}/detail
//
// Returns the family's parents + all active students. Used by the
// inline family-accordion cell on the Student Roster row — click the
// family name and the row expands to show this data without leaving
// the dashboard.
//
// School-session-authed. Results scoped to the cookie's school_id so
// a crafted familyId from another school returns empty.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ familyId: string }>;

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { familyId } = await params;
  const ck = await cookies();

  // Auth: school session OR operator (back-office) session.
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const operatorSession = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  if (!schoolSession && !operatorSession) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Step 1: look up the family by id ALONE so we can give a useful
  // error when there's a school_id mismatch (most common cause: stale
  // cookie from testing in a different school's iframe). The cookie
  // mismatch case was previously masked as "family not found" — same
  // 404 path the code took for genuinely-missing rows.
  const { rows: famRows } = await query<{
    id: string; display_name: string | null; notes: string | null; status: string;
    school_id: string;
  }>(
    `SELECT id, display_name, notes, status, school_id FROM families WHERE id = $1`,
    [familyId],
  );
  if (famRows.length === 0) {
    return NextResponse.json({ ok: false, error: 'family not found' }, { status: 404 });
  }
  const family = famRows[0];

  // Step 2: enforce scope. Operator session = back-office cross-school
  // admin, allow. School session = must match the family's school_id.
  if (!operatorSession && schoolSession && schoolSession.school_id !== family.school_id) {
    return NextResponse.json({
      ok: false,
      error: 'wrong school',
      detail: "This family belongs to a different school than your current login. Refresh the page or sign in to the right school.",
    }, { status: 403 });
  }

  // schoolId we use downstream for the scoped sub-queries. Always the
  // family's own school_id once we've confirmed access.
  const schoolId = family.school_id;

  const { rows: parents } = await query<{
    id: string;
    first_name: string; last_name: string;
    email: string | null; phone: string | null;
    is_primary: boolean; role: string;
    ghl_contact_id: string | null;
    is_private_from_co_parents: boolean;
    assigned_student_ids: string[];
  }>(
    // Aggregate per-student assignments alongside the parent record.
    // Empty array → applies to every student in the family (the
    // historical default); non-empty → explicitly scoped subset.
    `SELECT p.id, p.first_name, p.last_name, p.email, p.phone,
            p.is_primary, p.role, p.ghl_contact_id,
            COALESCE(p.is_private_from_co_parents, false) AS is_private_from_co_parents,
            COALESCE(
              (SELECT array_agg(psa.student_id::text)
                 FROM parent_student_assignments psa
                WHERE psa.parent_id = p.id),
              ARRAY[]::text[]
            ) AS assigned_student_ids
       FROM parents p
      WHERE p.family_id = $1 AND p.school_id = $2 AND p.status = 'active'
      ORDER BY p.is_primary DESC, p.first_name`,
    [familyId, schoolId],
  );

  const { rows: students } = await query<{
    id: string;
    first_name: string; last_name: string; preferred_name: string | null;
    date_of_birth: string | null; gender: string | null;
    homeroom: string | null; program: string | null;
  }>(
    `SELECT s.id, s.first_name, s.last_name, s.preferred_name,
            s.date_of_birth, s.gender,
            COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name') AS homeroom,
            s.metadata->>'program' AS program
       FROM students s
      WHERE s.family_id = $1 AND s.school_id = $2 AND s.status = 'active'
      ORDER BY s.date_of_birth NULLS LAST`,
    [familyId, schoolId],
  );

  // Authorized pickup persons. The pickup_persons table is keyed by the
  // parent who added them — so we walk every parent in the family and
  // collect their additions. Deduped by (name, phone) since parents
  // often add the same person twice (one per parent).
  const { rows: authorizedRaw } = await query<{
    id: string; name: string; relationship: string | null;
    phone: string | null; notes: string | null;
    added_by_parent: string | null;
  }>(
    `SELECT pp.id, pp.name, pp.relationship, pp.phone, pp.notes,
            (p.first_name || ' ' || p.last_name) AS added_by_parent
       FROM pickup_persons pp
       JOIN parents p ON p.id = pp.added_by_parent_id
      WHERE p.family_id = $1 AND p.school_id = $2 AND pp.active = true
      ORDER BY pp.name`,
    [familyId, schoolId],
  );
  // Dedupe by name + phone (parents often re-add the same person).
  const seen = new Set<string>();
  const authorized_pickups = authorizedRaw.filter((r) => {
    const key = `${(r.name ?? '').toLowerCase()}|${(r.phone ?? '').replace(/\D/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Unauthorized pickup restrictions. Per-student — show which student
  // each restriction applies to so the teacher can match face → kid.
  const { rows: pickup_restrictions } = await query<{
    id: string; student_id: string; student_display: string;
    person_name: string; relationship: string | null;
    reason: string | null; notes: string | null;
  }>(
    `SELECT r.id, r.student_id,
            (COALESCE(NULLIF(s.preferred_name, ''), s.first_name) || ' ' || s.last_name) AS student_display,
            r.person_name, r.relationship, r.reason, r.notes
       FROM student_pickup_restrictions r
       JOIN students s ON s.id = r.student_id
      WHERE s.family_id = $1 AND r.school_id = $2 AND r.active = true
      ORDER BY s.first_name, r.created_at`,
    [familyId, schoolId],
  );

  // Health profiles per student — emergency contact #1, doctor, hospital,
  // insurance, allergies, medications, medical conditions. Keyed by
  // student_id so the panel can show a card per student.
  const { rows: health_profiles } = await query<{
    student_id: string;
    emergency_contact_name: string | null;
    emergency_contact_relationship: string | null;
    emergency_contact_phone: string | null;
    emergency_contact_alt_phone: string | null;
    primary_doctor_name: string | null;
    primary_doctor_phone: string | null;
    preferred_hospital: string | null;
    health_insurance_provider: string | null;
    health_insurance_policy_number: string | null;
    allergies: string | null;
    current_medications: string | null;
    medical_conditions: string | null;
  }>(
    `SELECT student_id,
            emergency_contact_name, emergency_contact_relationship,
            emergency_contact_phone, emergency_contact_alt_phone,
            primary_doctor_name, primary_doctor_phone, preferred_hospital,
            health_insurance_provider, health_insurance_policy_number,
            allergies, current_medications, medical_conditions
       FROM student_health_profiles
      WHERE school_id = $1
        AND student_id IN (SELECT id FROM students WHERE family_id = $2 AND school_id = $1 AND status = 'active')`,
    [schoolId, familyId],
  );

  // Roster permissions + payment plan + days of attendance + the full
  // tuition blob (base/discounts/voucher/billed amount). Lives on
  // enrollments.metadata — both the Final Forms import and the
  // business-office tuition import write here.
  const { rows: enrollment_meta } = await query<{
    student_id: string;
    payment_plan: string | null;
    program: string | null;
    hours_of_attendance: string | null;
    days_of_attendance: string[] | null;
    roster_permissions: Record<string, boolean> | null;
    tuition: Record<string, unknown> | null;
  }>(
    `SELECT e.student_id,
            e.metadata->>'payment_plan' AS payment_plan,
            e.metadata->>'program' AS program,
            e.metadata->>'hours_of_attendance' AS hours_of_attendance,
            CASE WHEN jsonb_typeof(e.metadata->'days_of_attendance') = 'array'
                 THEN ARRAY(SELECT jsonb_array_elements_text(e.metadata->'days_of_attendance'))
                 ELSE NULL END AS days_of_attendance,
            e.metadata->'roster_permissions' AS roster_permissions,
            e.metadata->'tuition' AS tuition
       FROM enrollments e
       JOIN students s ON s.id = e.student_id
      WHERE s.family_id = $1 AND s.school_id = $2 AND s.status = 'active'
        AND e.status = 'enrolled'`,
    [familyId, schoolId],
  );

  // Medical form submissions per student — anything in the school's
  // 'medical' category, sorted newest-first. Includes form-definition
  // metadata so the panel can show "Request For Administering
  // Medication · submitted Mar 4" without an extra round-trip.
  const { rows: medical_forms } = await query<{
    submission_id: string;
    form_definition_id: string;
    form_display_name: string;
    form_slug: string;
    student_id: string;
    submitted_at: string;
    status: string;
    expires_on: string | null;
  }>(
    `SELECT s.id AS submission_id,
            d.id AS form_definition_id,
            d.display_name AS form_display_name,
            d.slug AS form_slug,
            s.student_id,
            s.submitted_at,
            s.status,
            -- Schools that capture expiration on the form typically
            -- store it in the response JSON under a key like
            -- 'medication_expiration' or 'expires_on'. Surface either
            -- so the panel can warn about expired meds. Defensive cast.
            COALESCE(
              s.responses->>'medication_expiration',
              s.responses->>'expires_on',
              s.responses->>'expiration_date'
            ) AS expires_on
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1
        AND d.category = 'medical'
        AND s.student_id IN (SELECT id FROM students WHERE family_id = $2 AND school_id = $1 AND status = 'active')
      ORDER BY s.submitted_at DESC NULLS LAST`,
    [schoolId, familyId],
  );

  return NextResponse.json({
    ok: true,
    family,
    parents,
    students,
    authorized_pickups,
    pickup_restrictions,
    health_profiles,
    enrollment_meta,
    medical_forms,
  });
}
