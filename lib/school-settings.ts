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
  };
}

export async function loadSchoolSettings(schoolId: string): Promise<SchoolSettings> {
  const { rows } = await query<{ settings: unknown }>(
    `SELECT settings FROM schools WHERE id = $1`,
    [schoolId],
  );
  return normalizeSchoolSettings(rows[0]?.settings);
}
