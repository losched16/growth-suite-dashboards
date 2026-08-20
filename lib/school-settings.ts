// Per-school settings (schools.settings jsonb, migration 071) — the
// data-driven replacement for what used to be hardcoded school-id sets
// sprinkled through the code. Absent keys fall back to the platform
// defaults below, so a brand-new school needs zero setup to behave sanely
// and every behavior is opt-in from the school Settings page.

import { query } from '@/lib/db';

export interface SchoolSettings {
  // Active academic year, e.g. '2026-27'. Drives enrollment rows, payment
  // plans, and the year the portal stamps on submissions.
  academic_year: string;
  // Pipeline stage that unlocks parent-portal account creation. null = any
  // active parent can create a login (ungated).
  portal_gate_stage: string | null;
  // Auto-assign a random 8-digit Student ID to active students missing one
  // (written to the contact first, then mirrored).
  auto_student_ids: boolean;
  // Nightly Parent-2 → own-contact promotion for email marketing.
  promote_parent2: boolean;
  // When non-empty: only contacts carrying one of these tags become roster
  // families ("withdrawn" keeps the family but marks students withdrawn).
  roster_tag_filter: string[];
  // CRM sidebar items to hide for this school's sub-account (GHL has no
  // native per-location menu toggle). Values are GHL sidebar element ids
  // without the "sb_" prefix (e.g. 'payments', 'opportunities'). Applied by
  // the agency Custom JS snippet, which fetches /api/ghl-menu-config/{loc}.
  ghl_hidden_menu: string[];
  // Collapse the same child across co-parent contacts into ONE student.
  // For schools whose GHL has each parent as a SEPARATE contact that both
  // list the family's children (no household link), the sync would otherwise
  // create a student row per parent → duplicates. When true, families that
  // share a student (same name + compatible DOB) are merged into one family
  // with both parents and one copy of each child. Default false — every
  // school that uses one-contact-per-family is unaffected (no shared students
  // → no-op). Name-collisions with DIFFERENT DOBs are left separate.
  merge_coparent_students: boolean;
  // EXPLICIT co-parent linkage: the GHL custom-field key holding a shared
  // "household id". When set, families whose PRIMARY contact carries the same
  // non-empty value in this field are collapsed into one family (both parents,
  // one copy of each child) — the source-of-truth alternative to inferring
  // co-parents from matching student names (merge_coparent_students). The
  // operator controls exactly which contacts pair up by writing the same id on
  // both. null/empty = off. Takes precedence over merge_coparent_students when
  // both are set. Does NOT gate the roster (unlike family_fields.householdId) —
  // a contact without a value simply stays its own family.
  coparent_household_field: string | null;
  // Poll GHL Documents & Contracts for completed (signed) documents each
  // sync cycle: flips the matching per-student tracking field (e.g. a
  // signed "AZ Emergency ... Card - S2" sets Student 2 AZ Card=Complete on
  // the primary contact) so the Portal Forms tracker greens automatically.
  // Opt-in per school.
  ghl_documents_sync: boolean;
  // Auto-fill Student N Program Name from the grade code when blank
  // (Leslie sets only Grade Level). Opt-in per school.
  derive_program_from_grade: boolean;
  // Office emails alerted when a student's enrollment status transitions
  // to Enrolled (lib/sync/enrollment-notifications). Empty = feature off
  // (the status ledger is still maintained so enabling later never
  // back-blasts old enrollments).
  enrollment_notification_emails: string[];
}

// GHL sidebar items the Custom JS snippet can hide (docs/ghl-menu-snippet.js).
// `key` = the element id without the `sb_` prefix. Community-stable ids.
export const GHL_MENU_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'launchpad', label: 'Launch Pad' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'calendars', label: 'Calendars' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'opportunities', label: 'Opportunities' },
  { key: 'payments', label: 'Payments' },
  { key: 'email-marketing', label: 'Marketing' },
  { key: 'automation', label: 'Automation' },
  { key: 'sites', label: 'Sites' },
  { key: 'memberships', label: 'Memberships' },
  { key: 'app-media', label: 'Media Storage' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'reporting', label: 'Reporting' },
  { key: 'app-marketplace', label: 'App Marketplace' },
];

export const SCHOOL_SETTINGS_DEFAULTS: SchoolSettings = {
  academic_year: '2026-27',
  portal_gate_stage: null,
  auto_student_ids: false,
  promote_parent2: false,
  roster_tag_filter: [],
  ghl_hidden_menu: [],
  merge_coparent_students: false,
  coparent_household_field: null,
  ghl_documents_sync: false,
  derive_program_from_grade: false,
  enrollment_notification_emails: [],
};

export function normalizeSchoolSettings(raw: unknown): SchoolSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    academic_year: typeof r.academic_year === 'string' && r.academic_year.trim()
      ? r.academic_year.trim() : SCHOOL_SETTINGS_DEFAULTS.academic_year,
    portal_gate_stage: typeof r.portal_gate_stage === 'string' && r.portal_gate_stage.trim()
      ? r.portal_gate_stage.trim() : null,
    auto_student_ids: r.auto_student_ids === true,
    promote_parent2: r.promote_parent2 === true,
    roster_tag_filter: Array.isArray(r.roster_tag_filter)
      ? r.roster_tag_filter.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [],
    ghl_hidden_menu: Array.isArray(r.ghl_hidden_menu)
      ? r.ghl_hidden_menu.map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean)
      : [],
    merge_coparent_students: r.merge_coparent_students === true,
    coparent_household_field: typeof r.coparent_household_field === 'string' && r.coparent_household_field.trim()
      ? r.coparent_household_field.trim() : null,
    ghl_documents_sync: r.ghl_documents_sync === true,
    derive_program_from_grade: r.derive_program_from_grade === true,
    enrollment_notification_emails: Array.isArray(r.enrollment_notification_emails)
      ? r.enrollment_notification_emails.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

export async function loadSchoolSettings(schoolId: string): Promise<SchoolSettings> {
  const { rows } = await query<{ settings: unknown }>(
    `SELECT settings FROM schools WHERE id = $1`,
    [schoolId],
  );
  return normalizeSchoolSettings(rows[0]?.settings);
}
