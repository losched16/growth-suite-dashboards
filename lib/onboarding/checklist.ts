// The onboarding checklist registry — the single source of truth for every
// step a school goes through to get their SOFTWARE built. (Billing/tuition
// pricing is the partner's separate track and intentionally absent here.)
//
// Four task types:
//   derived   — status computed live from real system tables (no stored state)
//   document  — school uploads a file (roster CSV, logo, handbook)
//   manual    — a checkbox/acknowledgement or an operator sign-off
//   intake    — structured values the school submits that get PUSHED into
//               their GHL sub-account (picklist options on custom fields).
//               This is how grade levels / programs / schedules / plan labels
//               become one source of truth across GHL fields, the roster
//               sync, dashboards, the parent portal, and form logic — instead
//               of being hand-typed per place (which is where drift/errors
//               creep in). See lib/onboarding/apply-intake.ts for the push.
//
// This is intentionally a SENSIBLE STARTER set — the exact list is easy to
// edit here without touching the engine. Add/remove/reorder tasks freely.

import { query } from '@/lib/db';

export type TaskType = 'derived' | 'document' | 'manual' | 'intake';
export type Phase = 'account' | 'data' | 'config' | 'launch';
export type Owner = 'school' | 'ops';

// Resolved status of a single task for a given onboarding.
export type TaskStatus =
  | 'blocked'       // a prerequisite task isn't done yet
  | 'not_started'
  | 'in_progress'   // submitted/uploaded but awaiting review/apply
  | 'done';

export interface OnboardingContext {
  onboardingId: string;
  schoolId: string | null; // null until the tenant is provisioned
}

interface BaseTask {
  key: string;
  title: string;
  phase: Phase;
  owner: Owner;
  instructions: string;       // markdown shown to the school
  blockedBy?: string[];       // task keys that must be `done` first
  // Optional deep-link into the embedded dashboard shell that completes this
  // step (only meaningful once the tenant is provisioned / locationId known).
  // Rendered as a "Do it in your dashboard →" link.
  ctaHref?: (locationId: string) => string;
}

export interface DerivedTask extends BaseTask {
  type: 'derived';
  // Computed from real system state. `done` when the thing actually exists.
  deriveDone: (ctx: OnboardingContext) => Promise<boolean>;
}

export interface DocumentTask extends BaseTask {
  type: 'document';
  accept: string[];           // MIME allow-list for the upload control
  multiple?: boolean;
}

export interface ManualTask extends BaseTask {
  type: 'manual';
}

export interface IntakeTask extends BaseTask {
  type: 'intake';
  // An option-list vocabulary. The submitted values are pushed onto every GHL
  // custom field whose name matches `Student N {fieldLabel}` (all slots) plus
  // any exact-name match — replacing the field-kit's 'Set at intake'
  // placeholder. See apply-intake.ts.
  intake: {
    kind: 'option_list';
    fieldLabel: string;       // e.g. 'Grade Level' → 'Student 1 Grade Level', …
    examples: string[];       // placeholder chips in the UI
    minItems?: number;
  };
}

export type OnboardingTask = DerivedTask | DocumentTask | ManualTask | IntakeTask;

// ── derive helpers ──────────────────────────────────────────────────────
// Each returns true when the real system state says the step is done. All
// guard on schoolId (null before provisioning → not done). Columns used are
// all ones that already exist; refine freely.

async function countExists(sql: string, params: unknown[]): Promise<boolean> {
  const { rows } = await query<{ n: number }>(sql, params);
  return (rows[0]?.n ?? 0) > 0;
}

// ── the registry ────────────────────────────────────────────────────────

export const ONBOARDING_CHECKLIST: OnboardingTask[] = [
  // ── Phase: account ──
  {
    key: 'account_created', type: 'derived', phase: 'account', owner: 'ops',
    title: 'Growth Suite account created',
    instructions: 'Your school workspace is created and connected to your GoHighLevel sub-account.',
    deriveDone: async (ctx) => ctx.schoolId != null,
  },
  {
    key: 'fields_provisioned', type: 'derived', phase: 'account', owner: 'ops',
    title: 'Custom fields provisioned',
    instructions: 'The standard student + parent field set has been installed on your sub-account.',
    blockedBy: ['account_created'],
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM school_field_schemas WHERE school_id = $1`, [ctx.schoolId]),
  },

  // ── Phase: data (intake vocabularies + submitted files) ──
  {
    key: 'intake_grade_levels', type: 'intake', phase: 'data', owner: 'school',
    title: 'Your grade levels',
    instructions: 'List the grade levels / class groupings your school uses. These become the Grade Level options everywhere — student records, dashboards, and forms.',
    intake: { kind: 'option_list', fieldLabel: 'Grade Level',
      examples: ['Toddler', 'Primary', 'Lower Elementary', 'Upper Elementary'], minItems: 1 },
  },
  {
    key: 'intake_programs', type: 'intake', phase: 'data', owner: 'school',
    title: 'Your programs',
    instructions: 'List the programs families can enroll in. Used for the Program field, dashboards, and form logic.',
    intake: { kind: 'option_list', fieldLabel: 'Program Name',
      examples: ['Half Day', 'Full Day', 'Extended Day'], minItems: 1 },
  },
  {
    key: 'intake_schedules', type: 'intake', phase: 'data', owner: 'school',
    title: 'Your daily schedules',
    instructions: 'List the daily schedule options you offer (e.g. how many days / hours).',
    intake: { kind: 'option_list', fieldLabel: 'Daily Schedule',
      examples: ['2 Days', '3 Days', '5 Days'], minItems: 1 },
  },
  {
    key: 'intake_classrooms', type: 'intake', phase: 'data', owner: 'school',
    title: 'Your classrooms / homerooms',
    instructions: 'List your classroom or homeroom names. Used for per-classroom dashboards and rosters.',
    intake: { kind: 'option_list', fieldLabel: 'Homeroom',
      examples: ['Room A', 'Room B', 'Sunflower Room'], minItems: 1 },
  },
  {
    key: 'roster_file', type: 'document', phase: 'data', owner: 'school',
    title: 'Submit your student roster',
    instructions: 'Upload your current student/family roster (CSV or Excel). We use this to import your families — you don’t have to enter them by hand.',
    accept: ['text/csv', 'application/vnd.ms-excel',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  {
    key: 'roster_imported', type: 'derived', phase: 'data', owner: 'ops',
    title: 'Roster imported',
    instructions: 'Your families and students are loaded into Growth Suite.',
    blockedBy: ['roster_file'],
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM families WHERE school_id = $1`, [ctx.schoolId]),
  },

  // ── Phase: config (branding, dashboards, forms, portal settings) ──
  {
    key: 'logo_upload', type: 'document', phase: 'config', owner: 'school',
    title: 'Submit your logo',
    instructions: 'Upload your school logo (PNG or SVG). It appears in your parent portal.',
    accept: ['image/png', 'image/svg+xml', 'image/jpeg'],
  },
  {
    key: 'branding_set', type: 'derived', phase: 'config', owner: 'school',
    title: 'Branding configured',
    instructions: 'Set your portal logo and colors.',
    ctaHref: (loc) => `/school/${loc}/settings`,
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM school_branding WHERE school_id = $1 AND logo_url IS NOT NULL`, [ctx.schoolId]),
  },
  {
    key: 'portal_configured', type: 'derived', phase: 'config', owner: 'school',
    title: 'Parent portal set up',
    instructions: 'Set your academic year and choose which portal sections parents see.',
    ctaHref: (loc) => `/school/${loc}/settings`,
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM schools WHERE id = $1 AND settings ? 'academic_year'`, [ctx.schoolId]),
  },
  {
    key: 'dashboards_setup', type: 'derived', phase: 'config', owner: 'school',
    title: 'Dashboards set up',
    instructions: 'Add at least one dashboard from the template gallery.',
    blockedBy: ['roster_imported'],
    ctaHref: (loc) => `/school/${loc}/dashboards/new`,
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM school_dashboards WHERE school_id = $1`, [ctx.schoolId]),
  },
  {
    key: 'forms_published', type: 'derived', phase: 'config', owner: 'school',
    title: 'Forms published',
    instructions: 'Create at least one parent form from a template and publish it.',
    ctaHref: (loc) => `/school/${loc}/forms/new`,
    deriveDone: async (ctx) =>
      ctx.schoolId != null &&
      countExists(`SELECT COUNT(*)::int n FROM portal_form_definitions WHERE school_id = $1`, [ctx.schoolId]),
  },

  // ── Phase: launch ──
  {
    key: 'confirm_ready', type: 'manual', phase: 'launch', owner: 'school',
    title: 'Confirm everything looks right',
    instructions: 'Review your dashboards, forms, and family data. Check this when you’re happy with the setup.',
    blockedBy: ['roster_imported', 'dashboards_setup'],
  },
  {
    key: 'ops_final_review', type: 'manual', phase: 'launch', owner: 'ops',
    title: 'Final review by Growth Suite',
    instructions: 'Our team does a final pass before your portal goes live to parents.',
    blockedBy: ['confirm_ready'],
  },
];

// Convenience lookup.
export const CHECKLIST_BY_KEY: Record<string, OnboardingTask> = Object.fromEntries(
  ONBOARDING_CHECKLIST.map((t) => [t.key, t]),
);

export const PHASE_ORDER: Phase[] = ['account', 'data', 'config', 'launch'];
export const PHASE_LABELS: Record<Phase, string> = {
  account: 'Account setup',
  data: 'Your data',
  config: 'Configuration',
  launch: 'Launch',
};
