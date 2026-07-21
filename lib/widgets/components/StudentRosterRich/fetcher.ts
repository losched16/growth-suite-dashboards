// Student Roster fetcher. Pulls all active students with their classroom +
// most-recent enrollment + family + parent name. Applies URL filters and
// returns a paginated slice.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { StudentRosterConfig } from './config';
import { ghlContactUrl } from '@/lib/ghl/contact-url';

// Filler / no-detail values teachers commonly see in legacy GHL data.
// Treat these as "no useful prose" — when the field is just "Yes" or
// "No" we'd rather pick a real description from a fallback source.
const NULLISH_TEXT = new Set(['', 'no', 'none', 'n/a', 'na', 'no.', 'none.', 'yes', 'yes.']);

// Per-student contact-field slot convention (desert-garden style):
// slot 1 'student_<base>', slots 2-4 'student_<n>_<base>'. Used to
// resolve a per-student attr to the ROW student's own slot rather than
// the contact's slot-1 values (which would repeat a sibling's data).
const STUDENT_SLOT_KEY_RE = /^student_(?:([2-4])_)?(.+)$/;
const slotFieldKey = (slot: number, base: string): string =>
  slot === 1 ? `student_${base}` : `student_${slot}_${base}`;

// Pick the most informative text out of any number of candidates.
// Priority: longest non-nullish string wins. Falls back to the bare
// "Yes" / "No" flag if NOTHING has prose, so the caller can still tell
// "there is no detail" from "this kid genuinely has no allergy".
function bestText(...candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    const t = c.trim();
    if (!t) continue;
    if (NULLISH_TEXT.has(t.toLowerCase())) continue;
    if (!best || t.length > best.length) best = t;
  }
  if (best) return best;
  // No prose found — return the first non-empty raw value if any, so
  // the column can still show the legacy "Yes" flag instead of "—".
  for (const c of candidates) {
    if (!c) continue;
    const t = c.trim();
    if (!t) continue;
    if (t.toLowerCase() === 'no' || t.toLowerCase() === 'none' || t.toLowerCase() === 'n/a' || t.toLowerCase() === 'na') {
      continue;
    }
    return t;
  }
  return null;
}

// True when the value indicates "yes there's something here" — used to
// flip the has_allergy badge on. "Yes" with no prose still flips it,
// so teachers see a flag and chase down the detail.
function isMeaningfulFlag(v: string | null | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  if (!t) return false;
  return !['no', 'none', 'n/a', 'na', 'no.', 'none.'].includes(t);
}

// Age at a specific reference date (e.g. a grade-cutoff date), rendered
// like "5y 3m" / "8m". Empty when no DOB.
function ageAtDate(dob: string | null, ref: Date): string {
  if (!dob) return '';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  let yrs = ref.getUTCFullYear() - d.getUTCFullYear();
  let mos = ref.getUTCMonth() - d.getUTCMonth();
  if (ref.getUTCDate() < d.getUTCDate()) mos--;
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs < 0) return ''; // born after the reference date
  return yrs >= 1 ? `${yrs}y ${Math.max(0, mos)}m` : `${Math.max(0, mos)}m`;
}

export interface RosterStudent {
  student_id: string;
  family_id: string;
  // Deep-link to the family's GHL contact record (null when no contact id
  // is on file). Built server-side so the CRM base URL stays off the client.
  ghl_contact_url: string | null;
  family_display_name: string | null;
  primary_parent_name: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  status: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  academic_year: string | null;
  // Age at the selected year's grade-cutoff dates (Aug 1 / Jan 1) plus the
  // current age (today) — the three age formulas DGM tracks for placement.
  age_as_of_aug1: string;
  age_as_of_jan1: string;
  age_as_of_today: string;
  program: string | null;
  homeroom: string | null;
  tuition: string | null;
  // Family home address (GHL-synced student_street/city/state/zip), composed
  // as one mail-ready line. Null when the contact has no street on file.
  address: string | null;
  // First day at the school (metadata.initial_start_date), raw string.
  initial_start_date: string | null;
  // The school-facing Student ID (metadata.student_id — GHL-synced or
  // auto-assigned). NOT the row uuid (that's student_id above).
  student_id_number: string | null;
  // Grade code from the contact record (metadata.grade_level: P2, U5, M7…).
  grade_level: string | null;
  allergy: string | null;
  special_instructions: string | null;
  iep: string | null;
  five04_plan: string | null;
  has_allergy: boolean;
  has_iep_or_504: boolean;
  // Lightweight count for the inline Documents cell on the roster. The
  // actual list is fetched lazily via /api/school/documents/list when
  // the operator clicks the cell.
  documents_count: number;
  // Lunch selection (from student.metadata.organic_lunch). Free-text
  // because schools name their tiers differently.
  lunch: string | null;
  has_lunch: boolean;          // true if anything other than declined / null
  // Today's attendance status — joined from daily_attendance using the
  // widget's configured timezone. 'not_yet' means we have no row for
  // today yet (default state at the start of each day).
  attendance_status: 'present' | 'partial' | 'checked_out' | 'absent' | 'not_yet';
  attendance_check_in_at: string | null;
  attendance_check_out_at: string | null;
  // Curbside pickup info — daily_attendance.curbside_pickup is the
  // canonical "did/will they curbside today" flag; slot comes from the
  // most recent check_out event with curbside=true.
  curbside_today: boolean;
  curbside_slot: string | null;
  // Notes left during today's most recent check_in event. Surface as
  // a column so teachers can see "had a rough morning" / "needs nap
  // by 10:30" without opening the attendance dashboard.
  attendance_notes: string | null;
  // People who are NOT authorized to pick up this kid (custody
  // arrangements, no-contact orders). Surfaced as a column so the
  // teacher at the door doesn't have to open the family accordion to
  // know who to refuse. Empty array = no restrictions.
  pickup_restrictions: Array<{ name: string; reason: string | null }>;
  // True when the school's GHL contact carries a "re-enrolled" tag.
  // Surfaced as a chip next to the student name.
  re_enrolled: boolean;
  search_haystack: string;
  // Self-serve attribute display values, keyed by catalog attr_key
  // ('tag', 'cf:donor_tier', 'opp_stage', …). Resolved from
  // students.metadata + the GHL attribute tables via the family's
  // linked contacts.
  dynamic: Record<string, string>;
}

// A dynamic filter the school configured (from school_filter_catalog),
// shipped to the FilterRow so it can render the right control.
export interface DynamicFilterDef {
  attr_key: string;
  label: string;
  data_type: string;       // 'select' | 'multi' | 'text' | 'number' | 'date'
  options: string[];       // choices for select/multi controls
}

export interface StudentRosterData {
  total_students: number;
  // Active status scope: 'enrolled' (default), 'pending', 'withdrawn', or 'all'.
  roster_status: 'enrolled' | 'pending' | 'withdrawn' | 'all';
  filtered: RosterStudent[];
  page_rows: RosterStudent[];
  page: number;
  per_page: number;
  page_count: number;
  options: {
    years: string[];
    programs: string[];
    homerooms: string[];
    schedules: string[];
    teachers: string[];
    genders: string[];
    lunches: string[];
    attendance_statuses: string[];
  };
  // Catalog-driven filters the school enabled (renders after the
  // static filters) + header labels for any dynamic columns.
  dynamic_filters: DynamicFilterDef[];
  dynamic_labels: Record<string, string>;
  // Count of active students whose linked Growth Suite contacts disagree
  // on a field (metadata.ghl_conflicts). Drives the roster warning pill.
  ghl_conflict_count: number;
  // For Allergies view
  allergies_by_homeroom: Array<{
    homeroom: string;
    students: RosterStudent[];
  }>;
}

interface DbRow {
  student_id: string;
  family_id: string;
  family_display_name: string | null;
  primary_first: string | null;
  primary_last: string | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  enrollment_status: string | null;
  academic_year: string | null;
  classroom_name: string | null;
  lead_teacher_name: string | null;
  schedule: string | null;
  metadata: Record<string, unknown>;
  documents_count: number;
  attendance_status: string | null;
  attendance_first_check_in_at: string | null;
  attendance_last_check_out_at: string | null;
  attendance_curbside: boolean | null;
  curbside_slot: string | null;
  // Fallback sources for allergy + special-needs text — populated by
  // the parent-portal AZ State Emergency / OTC Medication forms and the
  // yearly scripts/import-dgm-allergies.mjs run. We union these with
  // students.metadata so the roster picks up whichever source has the
  // longest meaningful text.
  hp_allergies: string | null;
  hp_medical_conditions: string | null;
  // Latest check-in notes from today (school-tz). Null if no check-in
  // happened yet OR if the check-in had no notes.
  attendance_notes_today: string | null;
  // JSON array of { name, reason } for everyone on this student's
  // pickup_restrictions list (active rows only).
  pickup_restrictions_json: Array<{ name: string; reason: string | null }> | null;
  unauthorized_pickup_text: string | null;
  // students.metadata.re_enrolled — true when the school's GHL contact
  // carries the "re-enrolled" tag. Set by the per-school tag sync;
  // null/false otherwise.
  re_enrolled_flag: boolean | null;
}

export async function fetcher(
  school: SchoolContext,
  config: StudentRosterConfig,
  searchParams?: WidgetSearchParams,
): Promise<StudentRosterData> {
  // Academic-year scope. Data-driven so it's multi-tenant safe: the
  // dropdown lists exactly the years this school has, and the default
  // is the latest one (URL param > widget config > latest available).
  // When a school has no enrollment years, fYear is '' → no year filter.
  const { rows: yearRows } = await query<{ academic_year: string | null }>(
    `SELECT DISTINCT e.academic_year
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE s.school_id = $1 AND e.academic_year IS NOT NULL`,
    [school.schoolId],
  );
  const availableYears = yearRows
    .map((r) => r.academic_year)
    .filter((y): y is string => !!y)
    .sort()
    .reverse();
  const fYear = ((searchParams ?? {}).academic_year
    ?? config.default_academic_year
    ?? availableYears[0]
    ?? '').trim();

  // Status scope. Default 'enrolled' = currently-enrolled only. The toggle
  // can widen to 'pending', 'withdrawn', or 'all' (everyone, any status).
  // Withdrawn students are otherwise hidden because the base filter requires
  // active. Pending/withdrawn families stay in GHL but drop off the default
  // roster — "removed from the dashboard" without deleting anything, and the
  // status still lives at the source (GHL contact field).
  const rosterStatusRaw = (((searchParams ?? {}).roster_status ?? '').trim());
  // enrolled_only pins the scope to currently-enrolled — the classroom/teacher
  // dashboards set it so an actual class list can never be widened to
  // pending/withdrawn kids via the URL toggle.
  const rosterStatus = config.enrolled_only
    ? 'enrolled'
    : (rosterStatusRaw === 'pending' || rosterStatusRaw === 'withdrawn' || rosterStatusRaw === 'all')
      ? rosterStatusRaw : 'enrolled';

  // Grade-cutoff reference dates, derived from the selected year:
  // "2026-27" → Aug 1 2026 and Jan 1 2027. Falls back to the calendar
  // year if the year string isn't in YYYY-YY form.
  const ym = /^(\d{4})-\d{2}$/.exec(fYear);
  const cutoffStartYear = ym ? parseInt(ym[1], 10) : new Date().getFullYear();
  const augRef = new Date(Date.UTC(cutoffStartYear, 7, 1));      // Aug 1, start year
  const janRef = new Date(Date.UTC(cutoffStartYear + 1, 0, 1));  // Jan 1, next year

  const { rows } = await query<DbRow>(
    `SELECT
       s.id AS student_id,
       f.id AS family_id,
       f.display_name AS family_display_name,
       (SELECT first_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_first,
       (SELECT last_name FROM parents pp WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_last,
       s.first_name, s.last_name, s.preferred_name, s.date_of_birth, s.gender,
       e.status AS enrollment_status,
       e.academic_year,
       c.name AS classroom_name,
       c.lead_teacher_name,
       e.schedule,
       s.metadata,
       COALESCE(dc.n, 0) AS documents_count,
       da.status              AS attendance_status,
       da.first_check_in_at   AS attendance_first_check_in_at,
       da.last_check_out_at   AS attendance_last_check_out_at,
       da.curbside_pickup     AS attendance_curbside,
       cs.curbside_slot       AS curbside_slot,
       shp.allergies          AS hp_allergies,
       shp.medical_conditions AS hp_medical_conditions,
       an.notes               AS attendance_notes_today,
       pr.restrictions_json   AS pickup_restrictions_json,
       s.metadata->>'unauthorized__do_not_pickup' AS unauthorized_pickup_text,
       (s.metadata->>'re_enrolled')::boolean AS re_enrolled_flag
     FROM students s
     JOIN families f ON f.id = s.family_id
     LEFT JOIN LATERAL (
       -- Prefer the enrollment for the selected academic year ($3) so a
       -- returning student surfaces the right year's row; fall back to
       -- their most recent enrollment otherwise.
       SELECT * FROM enrollments e2 WHERE e2.student_id = s.id
        ORDER BY (e2.academic_year = $3) DESC, e2.created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS n FROM student_documents sd WHERE sd.student_id = s.id AND sd.is_complete = true
     ) dc ON true
     LEFT JOIN daily_attendance da
       ON da.student_id = s.id
      AND da.school_id  = s.school_id
      AND da.date       = ((now() AT TIME ZONE $2)::date)
     LEFT JOIN LATERAL (
       -- Most recent curbside slot from today's events. Considers ALL
       -- event types — check_in (morning intent) AND check_out (actual
       -- curbside pickup). Migration 033 broadened the trigger to do
       -- the same on daily_attendance.curbside_pickup.
       SELECT curbside_slot
         FROM attendance_events
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND curbside   = true
          AND curbside_slot IS NOT NULL
          AND (performed_at AT TIME ZONE $2)::date = ((now() AT TIME ZONE $2)::date)
        ORDER BY performed_at DESC LIMIT 1
     ) cs ON true
     LEFT JOIN student_health_profiles shp
       ON shp.student_id = s.id AND shp.school_id = s.school_id
     LEFT JOIN LATERAL (
       -- Most recent check-in event TODAY (school tz) with non-empty
       -- notes. Skips the auto-generated "Admin manual check-in" sentinel
       -- since that's noise — teachers care about substantive notes
       -- (mood, illness, drop-off changes).
       SELECT notes
         FROM attendance_events
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND event_type = 'check_in'
          AND notes IS NOT NULL AND btrim(notes) <> ''
          AND lower(btrim(notes)) <> 'admin manual check-in'
          AND (performed_at AT TIME ZONE $2)::date = ((now() AT TIME ZONE $2)::date)
        ORDER BY performed_at DESC LIMIT 1
     ) an ON true
     LEFT JOIN LATERAL (
       -- All active pickup restrictions for this student. Aggregated
       -- as a JSON array so the column renderer can show one chip per
       -- person without a join at render time. Empty = NULL → []
       SELECT jsonb_agg(jsonb_build_object('name', person_name, 'reason', reason)
                        ORDER BY person_name) AS restrictions_json
         FROM student_pickup_restrictions
        WHERE student_id = s.id
          AND school_id  = s.school_id
          AND active     = true
     ) pr ON true
     WHERE s.school_id = $1
       -- Demo / test records (metadata.is_demo = true) are KEPT in the DB
       -- for the operator's own testing but never counted on any dashboard.
       -- Every roster/hub fetcher applies this same exclusion so the
       -- Student Roster, Family Hub, and Enrollment Hub agree.
       AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
       -- Optional: restrict to accepted/enrolled stages for schools whose
       -- roster is still an admissions pipeline ($4 NULL = show all).
       AND ($4::text[] IS NULL OR s.metadata->>'ghl_stage_name' = ANY($4))
       -- Status scope ($5). Default 'enrolled' = active students whose
       -- current-year enrollment status is 'enrolled' (the true student
       -- body). 'pending'/'withdrawn' = exactly those; 'all' = everyone.
       AND (
         CASE $5::text
           WHEN 'enrolled'  THEN (s.status = 'active' AND e.status = 'enrolled')
           WHEN 'pending'   THEN (s.status = 'active' AND e.status = 'pending')
           WHEN 'withdrawn' THEN (s.status = 'withdrawn' OR e.status = 'withdrawn')
           -- 'all': everyone in the roster, any status.
           ELSE                  (s.status = 'active' OR s.status = 'withdrawn' OR e.status = 'withdrawn')
         END
       )
     -- s.id tiebreaker keeps the order stable across renders (first_name
     -- isn't unique), so paginating can never repeat or drop a student.
     ORDER BY s.first_name, s.id`,
    // Hardcoded DG timezone for now. If a future widget needs to do
    // this for another school, lift to widget config.
    [school.schoolId, 'America/Phoenix', fYear,
     (config.enrolled_stage_names && config.enrolled_stage_names.length > 0) ? config.enrolled_stage_names : null,
     rosterStatus],
  );

  // ── Self-serve attributes (tags / GHL fields / opportunities) ──────
  // Attrs in play = whatever the school configured as extra filters or
  // columns, plus any f_<attr> URL param (so deep links work even
  // before the config is saved).
  const spAll = searchParams ?? {};
  const activeAttrs = new Set<string>([
    ...(config.extra_filters ?? []),
    ...(config.extra_columns ?? []),
  ]);
  for (const k of Object.keys(spAll)) {
    if (k.startsWith('f_') && (spAll[k] ?? '').trim()) activeAttrs.add(k.slice(2));
  }

  interface CatalogRow { attr_key: string; attr_type: string; label: string; data_type: string | null; sample_values: unknown }
  let catalogRows: CatalogRow[] = [];
  // contact id → values, loaded only for what's in play
  const tagsByContact = new Map<string, Set<string>>();
  const cfvByContact = new Map<string, Map<string, string>>();
  const oppByContact = new Map<string, { stages: Set<string>; statuses: Set<string>; pipelines: Set<string> }>();
  // family id → linked GHL contact ids (via parents)
  const contactsByFamily = new Map<string, string[]>();
  // student id → FACTS ledger figures in cents (charges + credits +
  // totals merged; split-household second ledgers sum together)
  const factsByStudent = new Map<string, Map<string, number>>();

  if (activeAttrs.size > 0) {
    const { rows: cat } = await query<CatalogRow>(
      `SELECT attr_key, attr_type, label, data_type, sample_values
         FROM school_filter_catalog WHERE school_id = $1 AND attr_key = ANY($2::text[])`,
      [school.schoolId, [...activeAttrs]],
    );
    catalogRows = cat;

    const { rows: parentLinks } = await query<{ family_id: string; ghl_contact_id: string }>(
      `SELECT family_id, ghl_contact_id FROM parents
        WHERE school_id = $1 AND ghl_contact_id IS NOT NULL AND status = 'active'`,
      [school.schoolId],
    );
    for (const pl of parentLinks) {
      const list = contactsByFamily.get(pl.family_id) ?? [];
      list.push(pl.ghl_contact_id);
      contactsByFamily.set(pl.family_id, list);
    }

    if (activeAttrs.has('tag')) {
      const { rows: tagRows } = await query<{ ghl_contact_id: string; tag: string }>(
        `SELECT ghl_contact_id, tag FROM ghl_contact_tags WHERE school_id = $1`,
        [school.schoolId],
      );
      for (const t of tagRows) {
        const set = tagsByContact.get(t.ghl_contact_id) ?? new Set<string>();
        set.add(t.tag);
        tagsByContact.set(t.ghl_contact_id, set);
      }
    }

    // Per-student slot fields (student_<base> / student_<2-4>_<base>)
    // resolve to the ROW student's own slot, so picking "Student ID"
    // never shows a sibling's value. Load every slot variant of any
    // student_* key in play so the per-slot lookup has data.
    const cfKeySet = new Set<string>();
    for (const a of activeAttrs) {
      if (!a.startsWith('cf:')) continue;
      const key = a.slice(3);
      cfKeySet.add(key);
      const m = STUDENT_SLOT_KEY_RE.exec(key);
      if (m) for (let sl = 1; sl <= 4; sl++) cfKeySet.add(slotFieldKey(sl, m[2]));
    }
    const cfKeys = [...cfKeySet];
    if (cfKeys.length > 0) {
      const { rows: cfvRows } = await query<{ ghl_contact_id: string; field_key: string; value: string }>(
        `SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values
          WHERE school_id = $1 AND field_key = ANY($2::text[])`,
        [school.schoolId, cfKeys],
      );
      for (const r2 of cfvRows) {
        const m = cfvByContact.get(r2.ghl_contact_id) ?? new Map<string, string>();
        m.set(r2.field_key, r2.value);
        cfvByContact.set(r2.ghl_contact_id, m);
      }
    }

    if (activeAttrs.has('opp_stage') || activeAttrs.has('opp_status') || activeAttrs.has('pipeline')) {
      const { rows: oppRows } = await query<{ ghl_contact_id: string | null; stage_name: string | null; status: string | null; pipeline_name: string | null }>(
        `SELECT ghl_contact_id, stage_name, status, pipeline_name FROM ghl_opportunities WHERE school_id = $1`,
        [school.schoolId],
      );
      for (const o of oppRows) {
        if (!o.ghl_contact_id) continue;
        const e = oppByContact.get(o.ghl_contact_id) ?? { stages: new Set<string>(), statuses: new Set<string>(), pipelines: new Set<string>() };
        if (o.stage_name) e.stages.add(o.stage_name);
        if (o.status) e.statuses.add(o.status);
        if (o.pipeline_name) e.pipelines.add(o.pipeline_name);
        oppByContact.set(o.ghl_contact_id, e);
      }
    }

    // FACTS ledger figures, scoped to the selected school year. A
    // student with two ledgers (split households) sums across them.
    if ([...activeAttrs].some((a) => a.startsWith('facts:'))) {
      const { rows: factsRows } = await query<{
        student_id: string;
        charges: Record<string, number> | null;
        credits: Record<string, number> | null;
        total_charges_cents: number; total_credits_cents: number;
        net_charges_cents: number; payments_cents: number;
        credits_applied_cents: number; remaining_balance_cents: number;
      }>(
        `SELECT student_id, charges, credits, total_charges_cents, total_credits_cents,
                net_charges_cents, payments_cents, credits_applied_cents, remaining_balance_cents
           FROM facts_transactions
          WHERE school_id = $1 AND student_id IS NOT NULL
            AND ($2::text = '' OR academic_year = $2)`,
        [school.schoolId, fYear ?? ''],
      );
      for (const fr of factsRows) {
        const m = factsByStudent.get(fr.student_id) ?? new Map<string, number>();
        const add = (k: string, v: unknown) => {
          const n = Number(v);
          if (n) m.set(k, (m.get(k) ?? 0) + n);
        };
        for (const [k, v] of Object.entries(fr.charges ?? {})) add(k, v);
        for (const [k, v] of Object.entries(fr.credits ?? {})) add(k, v);
        add('total_charges', fr.total_charges_cents);
        add('total_credits', fr.total_credits_cents);
        add('net_charges', fr.net_charges_cents);
        add('payments', fr.payments_cents);
        add('credits_applied', fr.credits_applied_cents);
        add('remaining_balance', fr.remaining_balance_cents);
        factsByStudent.set(fr.student_id, m);
      }
    }
  }

  // "$4,950" / "$812.50" — cents to a display dollar string.
  function fmtFactsCents(c: number): string {
    const hasCents = c % 100 !== 0;
    return `$${(c / 100).toLocaleString('en-US', {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    })}`;
  }

  // Resolve one student's dynamic display values across their linked
  // contacts (family parents + the contact stamped on the student).
  function resolveDynamic(studentId: string, familyId: string, md: Record<string, unknown>): Record<string, string> {
    if (activeAttrs.size === 0) return {};
    const contactIds = new Set<string>(contactsByFamily.get(familyId) ?? []);
    const mdContact = typeof md.ghl_contact_id === 'string' ? md.ghl_contact_id : null;
    if (mdContact) contactIds.add(mdContact);
    const out: Record<string, string> = {};
    for (const attr of activeAttrs) {
      if (attr.startsWith('facts:')) {
        const cents = factsByStudent.get(studentId)?.get(attr.slice(6));
        if (cents != null) out[attr] = fmtFactsCents(cents);
      } else if (attr === 'tag') {
        const tags = new Set<string>();
        for (const cid of contactIds) for (const t of tagsByContact.get(cid) ?? []) tags.add(t);
        if (tags.size) out.tag = [...tags].sort().join(', ');
      } else if (attr.startsWith('cf:')) {
        const key = attr.slice(3);
        const slotMatch = STUDENT_SLOT_KEY_RE.exec(key);
        let v = '';
        if (slotMatch) {
          // Per-student field. The row student's own metadata wins
          // (the import stores values under the base key; GHL's slot
          // base 'id' maps to metadata 'unique_id'); the contact-field
          // fallback reads THIS student's slot, never a sibling's.
          const base = slotMatch[2];
          const mdKey = base === 'id' ? 'unique_id' : base;
          const mdVal = md[mdKey];
          v = mdVal != null && String(mdVal).trim() !== '' ? String(mdVal) : '';
          if (!v) {
            const slot = parseInt(String(md.ghl_slot ?? ''), 10);
            if (Number.isInteger(slot) && slot >= 1 && slot <= 4) {
              const sk = slotFieldKey(slot, base);
              for (const cid of contactIds) {
                const cv = cfvByContact.get(cid)?.get(sk);
                if (cv) { v = cv; break; }
              }
            }
          }
        } else {
          // Family/contact-level field — metadata first, then any
          // linked contact's value.
          const mdVal = md[key];
          v = mdVal != null && String(mdVal).trim() !== '' ? String(mdVal) : '';
          if (!v) {
            for (const cid of contactIds) {
              const cv = cfvByContact.get(cid)?.get(key);
              if (cv) { v = cv; break; }
            }
          }
        }
        if (v) out[attr] = v;
      } else if (attr === 'opp_stage' || attr === 'opp_status' || attr === 'pipeline') {
        const vals = new Set<string>();
        for (const cid of contactIds) {
          const e = oppByContact.get(cid);
          if (!e) continue;
          const src = attr === 'opp_stage' ? e.stages : attr === 'opp_status' ? e.statuses : e.pipelines;
          for (const v of src) vals.add(v);
        }
        if (vals.size) out[attr] = [...vals].sort().join(', ');
      }
    }
    return out;
  }

  // Defensive: one roster row per student, always. The query is already
  // one-row-per-student, but this guarantees the invariant so a future
  // join change can never surface a student twice.
  const seenStudentIds = new Set<string>();
  const all: RosterStudent[] = rows.filter((r) => {
    if (seenStudentIds.has(r.student_id)) return false;
    seenStudentIds.add(r.student_id);
    return true;
  }).map((r) => {
    const md = r.metadata ?? {};
    const metadataAllergy = typeof md.allergy === 'string' ? md.allergy : null;
    const metadataSpecial = typeof md.special_instructions === 'string' ? md.special_instructions : null;
    // Pick whichever source has the longest meaningful TEXT, falling
    // back from the more-authoritative metadata.allergy → health_profiles.
    // A bare "Yes" / "No" / "None" is treated as no detail.
    const allergy = bestText(metadataAllergy, r.hp_allergies);
    const special_instructions = bestText(metadataSpecial, r.hp_medical_conditions);
    const iep = typeof md.iep === 'string' ? md.iep : null;
    const five04 = typeof md.five04_plan === 'string' ? md.five04_plan : null;
    // Lead teacher: prefer the per-student value from the roster import
    // (metadata.lead_teacher) — it's the authoritative source and can't
    // drift when a student changes classrooms. Fall back to the
    // classroom row's teacher (via enrollment.classroom_id).
    const leadTeacher = (typeof md.lead_teacher === 'string' && md.lead_teacher.trim())
      ? md.lead_teacher.trim()
      : r.lead_teacher_name;
    const program = typeof md.program === 'string' ? md.program : null;
    const homeroom = typeof md.homeroom === 'string' ? md.homeroom : null;
    // Year-specific tuition. metadata already holds THIS student's
    // year's value (the roster is year-filtered), so toggling the year
    // dropdown shows the right number. Prefer the descriptive
    // program_tuition string ("… - $16,250"); fall back to tuition_fee.
    const tuition = typeof md.program_tuition === 'string' ? md.program_tuition
      : (md.tuition_fee != null && md.tuition_fee !== '' ? String(md.tuition_fee) : null);
    const initialStart = typeof md.initial_start_date === 'string' && md.initial_start_date.trim()
      ? md.initial_start_date.trim() : null;
    const studentIdNumber = md.student_id != null && String(md.student_id).trim()
      ? String(md.student_id).trim() : null;
    const gradeLevel = typeof md.grade_level === 'string' && md.grade_level.trim()
      ? md.grade_level.trim() : null;
    // The diet selection lives in organic_lunch_choice ("… - Vegetarian");
    // organic_lunch itself is the FEE ("2100"/"0") since the enrollment
    // form's write_amount writeback — numeric values are not a label.
    const lunchChoice = typeof md.organic_lunch_choice === 'string' && md.organic_lunch_choice.trim()
      ? md.organic_lunch_choice.trim() : null;
    const lunchLegacy = typeof md.organic_lunch === 'string' && md.organic_lunch.trim() && !/^\d+(\.\d+)?$/.test(md.organic_lunch.trim())
      ? md.organic_lunch.trim() : null;
    const lunch = lunchChoice ?? lunchLegacy;
    const lunchLower = (lunch ?? '').toLowerCase();
    // "has lunch" = anything other than declined/blank. Declined values
    // start with "I decline" in DGM's GHL data, but we also tolerate a
    // bare "declined" string for robustness.
    const has_lunch = !!lunch && !lunchLower.includes('decline');
    // Mail-ready home address from the GHL-synced address fields (2.0 keys
    // student_street/…, bare-key fallbacks for other schools).
    const mdStr = (k: string): string => (typeof md[k] === 'string' ? (md[k] as string).trim() : '');
    const addrStreet = mdStr('student_street') || mdStr('street');
    const addrCity = mdStr('student_city') || mdStr('city');
    const addrState = mdStr('student_state') || mdStr('state');
    const addrZip = mdStr('student_zip') || mdStr('zip');
    const address = addrStreet
      ? [addrStreet, [addrCity, addrState].filter(Boolean).join(', '), addrZip].filter(Boolean).join(', ')
      : null;
    const primary = `${r.primary_first ?? ''} ${r.primary_last ?? ''}`.trim();
    // has_allergy considers EITHER source — the legacy "Yes" metadata
    // flag (no detail) AND any non-empty health-profile allergy both
    // light up the badge, even if the rendered text is "(no detail
    // on file)". Teachers need the flag even when prose isn't there.
    const has_allergy = isMeaningfulFlag(metadataAllergy) || isMeaningfulFlag(r.hp_allergies);
    const has_iep_or_504 = (!!iep && iep.toLowerCase() !== 'no') || (!!five04 && five04.toLowerCase() !== 'no');
    const haystack = [r.first_name, r.last_name, r.preferred_name ?? '', primary, r.family_display_name ?? '']
      .join(' ').toLowerCase();
    // daily_attendance.status is the canonical source. If no row exists
    // for today, the LEFT JOIN returns null → we surface that as
    // 'not_yet' (matches AttendanceDashboard's semantics).
    const attendance_status = (
      (r.attendance_status as RosterStudent['attendance_status']) ?? 'not_yet'
    );
    return {
      student_id: r.student_id,
      family_id: r.family_id,
      family_display_name: r.family_display_name,
      primary_parent_name: primary || '(unnamed)',
      first_name: r.first_name,
      last_name: r.last_name,
      preferred_name: r.preferred_name,
      date_of_birth: r.date_of_birth,
      gender: r.gender,
      status: r.enrollment_status,
      classroom_name: r.classroom_name,
      lead_teacher_name: leadTeacher,
      schedule: r.schedule,
      academic_year: r.academic_year,
      age_as_of_aug1: ageAtDate(r.date_of_birth, augRef),
      age_as_of_jan1: ageAtDate(r.date_of_birth, janRef),
      age_as_of_today: ageAtDate(r.date_of_birth, new Date()),
      program,
      homeroom,
      tuition,
      address,
      initial_start_date: initialStart,
      student_id_number: studentIdNumber,
      grade_level: gradeLevel,
      allergy,
      special_instructions,
      iep,
      five04_plan: five04,
      has_allergy,
      has_iep_or_504,
      documents_count: Number(r.documents_count ?? 0),
      lunch,
      has_lunch,
      attendance_status,
      attendance_check_in_at: r.attendance_first_check_in_at,
      attendance_check_out_at: r.attendance_last_check_out_at,
      curbside_today: !!r.attendance_curbside,
      curbside_slot: r.curbside_slot,
      attendance_notes: r.attendance_notes_today,
      // Structured restriction rows win; when the school only filled the GHL
      // contact's free-text "Unauthorized / Do Not Pickup" field, surface
      // that VERBATIM as one entry — custody language must never be lost
      // to parsing. (DGM: 10 students carry entries only in the GHL field.)
      pickup_restrictions: Array.isArray(r.pickup_restrictions_json) && r.pickup_restrictions_json.length > 0
        ? r.pickup_restrictions_json
        : (r.unauthorized_pickup_text ?? '').trim()
          ? [{ name: (r.unauthorized_pickup_text ?? '').trim(), reason: null }]
          : [],
      re_enrolled: r.re_enrolled_flag === true,
      search_haystack: haystack,
      ghl_contact_url: (typeof md.ghl_contact_id === 'string' && md.ghl_contact_id)
        ? ghlContactUrl(school.locationId, md.ghl_contact_id) : null,
      dynamic: resolveDynamic(r.student_id, r.family_id, md),
    };
  });

  const uniq = (vals: Iterable<string | null | undefined>): string[] =>
    [...new Set([...vals].filter((v): v is string => !!v && v.trim().length > 0))].sort();

  const options = {
    // Authoritative list of the school's years (newest first), so the
    // dropdown is stable regardless of the current selection.
    years: availableYears,
    programs: uniq(all.map((s) => s.program ?? s.classroom_name)),
    homerooms: uniq(all.map((s) => s.homeroom ?? s.classroom_name)),
    schedules: uniq(all.map((s) => s.schedule)),
    teachers: uniq(all.map((s) => s.lead_teacher_name)),
    genders: uniq(all.map((s) => s.gender)),
    lunches: uniq(all.map((s) => s.lunch)),
    attendance_statuses: ['present', 'partial', 'checked_out', 'absent', 'not_yet'],
  };

  const sp = searchParams ?? {};
  const search = (sp.q ?? '').trim().toLowerCase();
  const fProg = (sp.program ?? config.default_program_filter ?? '').trim();
  // URL param wins; otherwise fall back to the widget-config default.
  // Per-classroom dashboards set this in their layout so the roster
  // pre-scopes to one classroom on first render. lock_homeroom (teacher
  // dashboards): the config's classroom pin always wins — `?homeroom=` in
  // the URL (including an EMPTY value, which would clear the filter and
  // expose the whole school) is ignored.
  const fHome = (config.lock_homeroom && config.default_homeroom_filter
    ? config.default_homeroom_filter
    : (sp.homeroom ?? config.default_homeroom_filter ?? '')).trim();
  const fSched = (sp.schedule ?? '').trim();
  const fTeacher = (sp.lead_teacher ?? '').trim();
  const fGender = (sp.gender ?? '').trim();
  const allergiesOnly = sp.allergies_only === '1' || sp.allergies_only === 'true';
  const iepOnly = sp.iep_504_only === '1' || sp.iep_504_only === 'true';
  const fLunch = (sp.lunch ?? '').trim();
  const lunchOnly = sp.lunch_only === '1' || sp.lunch_only === 'true';
  const fAttendance = (sp.attendance_status ?? '').trim();
  const curbsideOnly = sp.curbside_only === '1' || sp.curbside_only === 'true';
  const reEnrolledOnly = sp.re_enrolled_only === '1' || sp.re_enrolled_only === 'true';

  // Active dynamic filters: f_<attr_key> URL params with a value.
  const dynFilters: Array<{ attr: string; value: string; exact: boolean }> = [];
  for (const [k, vRaw] of Object.entries(spAll)) {
    if (!k.startsWith('f_')) continue;
    const v = (vRaw ?? '').trim();
    if (!v) continue;
    const attr = k.slice(2);
    const catRow = catalogRows.find((c) => c.attr_key === attr);
    const dt = catRow?.data_type ?? 'text';
    dynFilters.push({ attr, value: v, exact: dt === 'select' || dt === 'multi' });
  }

  const filtered = all.filter((s) => {
    // Year scope: the enrollment join already surfaced the selected
    // year's row when the student has one; require it to match so
    // students without a same-year enrollment fall out of view.
    if (fYear && (s.academic_year ?? '') !== fYear) return false;
    // Self-serve attribute filters. Multi-value attrs (tags, opp
    // stages) store a comma-joined display string — exact matching
    // checks set membership; text/number/date use contains.
    for (const f of dynFilters) {
      const display = s.dynamic[f.attr] ?? '';
      if (f.exact) {
        const parts = display.split(', ').map((p) => p.trim().toLowerCase());
        if (!parts.includes(f.value.toLowerCase())) return false;
      } else {
        // Numeric operators for money/number attrs (FACTS figures,
        // numeric contact fields): ">0", ">=100", "<5000", "=395".
        const opMatch = /^(>=|<=|>|<|=)\s*\$?([\d,]+(?:\.\d+)?)$/.exec(f.value);
        const num = parseFloat(display.replace(/[^0-9.\-]/g, ''));
        if (opMatch && display !== '' && Number.isFinite(num)) {
          const target = parseFloat(opMatch[2].replace(/,/g, ''));
          const op = opMatch[1];
          const pass = op === '>' ? num > target
            : op === '>=' ? num >= target
            : op === '<' ? num < target
            : op === '<=' ? num <= target
            : num === target;
          if (!pass) return false;
        } else if (opMatch && display === '') {
          // Operator filter on a student with no value → excluded
          // (">0" means "has this charge").
          return false;
        } else if (
          !display.toLowerCase().includes(f.value.toLowerCase())
          // Money displays carry "$" and "," — match bare digits too,
          // so typing 4950 finds "$4,950".
          && !display.replace(/[$,]/g, '').toLowerCase().includes(f.value.toLowerCase())
        ) {
          return false;
        }
      }
    }
    if (fProg && (s.program ?? s.classroom_name ?? '') !== fProg) return false;
    if (fHome && (s.homeroom ?? s.classroom_name ?? '') !== fHome) return false;
    if (fSched && (s.schedule ?? '') !== fSched) return false;
    if (fTeacher && (s.lead_teacher_name ?? '') !== fTeacher) return false;
    if (fGender && (s.gender ?? '') !== fGender) return false;
    if (allergiesOnly && !s.has_allergy) return false;
    if (iepOnly && !s.has_iep_or_504) return false;
    if (fLunch && (s.lunch ?? '') !== fLunch) return false;
    if (lunchOnly && !s.has_lunch) return false;
    if (fAttendance && s.attendance_status !== fAttendance) return false;
    if (curbsideOnly && !s.curbside_today) return false;
    if (reEnrolledOnly && !s.re_enrolled) return false;
    if (search && !s.search_haystack.includes(search)) return false;
    return true;
  });

  // Sort (server-side so it orders the WHOLE filtered set, not just the
  // visible page). Default: last name A–Z. Clickable headers set ?sort=&dir=.
  const sortKey = (sp.sort ?? 'last_name').trim();
  const sortDesc = sp.dir === 'desc';
  const sortText = (x: RosterStudent): string => {
    switch (sortKey) {
      case 'first_name': return (x.preferred_name || x.first_name || '');
      case 'last_name': return x.last_name || '';
      case 'program': return x.program || x.classroom_name || '';
      case 'homeroom': return x.homeroom || x.classroom_name || '';
      case 'schedule': return x.schedule || '';
      case 'status': return x.status || '';
      case 'tuition': return x.tuition || '';
      case 'initial_start_date': return x.initial_start_date || '';
      case 'student_id': return x.student_id_number || '';
      case 'grade_level': return x.grade_level || '';
      default:
        // Dynamic (catalog) columns sort by their display value.
        if (x.dynamic[sortKey] !== undefined) return x.dynamic[sortKey];
        return x.last_name || '';
    }
  };
  filtered.sort((a, b) =>
    sortText(a).localeCompare(sortText(b), undefined, { numeric: true, sensitivity: 'base' }) * (sortDesc ? -1 : 1));

  const perPage = Math.max(25, Math.min(1000, Number(sp.per_page) || config.page_size || 100));
  const page = Math.max(1, Number(sp.page) || 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  // Allergies view: group by homeroom, only include students with allergies
  const allergyMap = new Map<string, RosterStudent[]>();
  for (const s of filtered.filter((x) => x.has_allergy)) {
    const home = s.homeroom ?? s.classroom_name ?? '(unassigned)';
    const list = allergyMap.get(home) ?? [];
    list.push(s);
    allergyMap.set(home, list);
  }
  const allergies_by_homeroom = [...allergyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([homeroom, students]) => ({ homeroom, students }));

  // Catalog-driven filter defs (only the ones the school enabled as
  // FILTERS — extra_columns don't get controls) + labels for any
  // dynamic column headers.
  const dynamic_filters: DynamicFilterDef[] = (config.extra_filters ?? [])
    .map((attr) => {
      const cat = catalogRows.find((c) => c.attr_key === attr);
      if (!cat) return null;
      const samples = Array.isArray(cat.sample_values) ? (cat.sample_values as unknown[]).map(String) : [];
      return {
        attr_key: cat.attr_key,
        label: cat.label,
        data_type: cat.data_type ?? 'text',
        options: samples,
      };
    })
    .filter((x): x is DynamicFilterDef => x !== null);
  const dynamic_labels: Record<string, string> = {};
  for (const c of catalogRows) dynamic_labels[c.attr_key] = c.label;

  const { rows: confRows } = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM students
      WHERE school_id = $1 AND status = 'active' AND metadata ? 'ghl_conflicts'`,
    [school.schoolId],
  );

  return {
    total_students: all.length,
    roster_status: rosterStatus,
    filtered,
    page_rows: pageRows,
    page: safePage,
    per_page: perPage,
    page_count: pageCount,
    options,
    dynamic_filters,
    dynamic_labels,
    ghl_conflict_count: confRows[0]?.n ?? 0,
    allergies_by_homeroom,
  };
}
