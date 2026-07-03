// GHL field audit — executable documentation of the platform's field
// contract. Run against a location's live custom fields at onboarding (and
// any time after) to catch structural problems BEFORE the first sync turns
// them into silently-empty dashboards.
//
// Philosophy (Clint, 2026-07-02): standardize STRUCTURE (field keys, types,
// the Enrollment Status picklist), never VALUES like grade or classroom
// names — every school names those differently, and we collect their
// naming during intake. So: keys/types are checked strictly; grade/homeroom
// values are surfaced as informational "confirm at intake" items.

import { parseStudentSlotKey } from '@/lib/sync/slot-keys';

export interface GhlFieldDef {
  id: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  picklistOptions?: unknown;
}

export type AuditLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface AuditItem {
  level: AuditLevel;
  title: string;
  detail: string;
}

export interface FieldAuditResult {
  items: AuditItem[];
  slots_detected: number;
  ok: boolean; // no 'fail' items
}

// Enrollment-status values the sync maps (normalizeEnrollmentStatus).
// Anything else on a contact → the student is not counted anywhere.
const KNOWN_STATUS_VALUES = new Set([
  'inquiry', 'tour scheduled', 'tour', 'application submitted', 'applied',
  'accepted', 'admitted', 'pending', 'pending enrollment', 'enrollment pending',
  'enrolled', 'enrolled not started', 'currently enrolled',
  'waitlist', 'waitlisted', 'withdrawn', 'withdrew', 'graduated',
  'declined', 'rejected', 'denied', 'inquired', 'lead',
]);

// Per-slot bases the platform reads, and what degrades without them.
const SLOT_BASES: Array<{ base: string; level: 'fail' | 'warn'; why: string }> = [
  { base: 'first_name', level: 'fail', why: 'students cannot sync at all without a first name per slot' },
  { base: 'last_name', level: 'warn', why: 'students fall back to the parent’s last name' },
  { base: 'enrollment_status', level: 'fail', why: 'rosters/hubs only count students whose status field says so — without it nobody shows as enrolled' },
  { base: 'birth_date', level: 'warn', why: 'ages and birthday-based views stay blank' },
  { base: 'grade_level', level: 'warn', why: 'grade filters and grade-gated form options won’t work' },
  { base: 'homeroom', level: 'warn', why: 'classroom dashboards can’t group students into rooms' },
  { base: 'student_id', level: 'warn', why: 'needed if the school wants auto Student IDs or references them in payment systems' },
];

// Contact-level Parent 2 fields (co-sign prefill/writeback + P2 marketing).
const PARENT2_FIELDS = ['parent_2_first_name', 'parent_2_last_name', 'parent_2_email', 'parent_2_mobile', 'parent_2_relationship'];

export function auditGhlFields(fields: GhlFieldDef[]): FieldAuditResult {
  const items: AuditItem[] = [];
  const keys = new Map<string, GhlFieldDef>();
  for (const f of fields) {
    const k = (f.fieldKey ?? '').replace(/^contact\./, '');
    if (k) keys.set(k, f);
  }

  // 1. Student slots present? (slot 1 may be bare `student_<base>` or `student_1_<base>`)
  const slots = new Set<number>();
  for (const k of keys.keys()) {
    const p = parseStudentSlotKey(k);
    if (p) slots.add(p.slot);
  }
  const slotCount = slots.size === 0 ? 0 : Math.max(...slots);
  if (slotCount === 0) {
    items.push({
      level: 'fail',
      title: 'No student fields found',
      detail: 'The location has no student_<field> / student_1..4_<field> custom fields. Import the Growth Suite field kit snapshot (or create the fields) before syncing — nothing can roster without them.',
    });
  } else {
    items.push({
      level: 'ok',
      title: `${slotCount} student slot${slotCount === 1 ? '' : 's'} detected`,
      detail: `Families can carry up to ${slotCount} student${slotCount === 1 ? '' : 's'} per contact (student_1_… through student_${slotCount}_…).`,
    });
  }

  // 2. Per-slot bases (checked on slot 1's naming; slots share conventions).
  const hasBase = (base: string): boolean =>
    keys.has(`student_${base}`) || keys.has(`student_1_${base}`);
  for (const b of SLOT_BASES) {
    if (slotCount === 0) break; // already failed above
    if (hasBase(b.base)) {
      items.push({ level: 'ok', title: `student ${b.base.replace(/_/g, ' ')} field present`, detail: '' });
    } else {
      items.push({
        level: b.level,
        title: `Missing student_${b.base} (or student_1_${b.base})`,
        detail: b.why,
      });
    }
  }

  // 3. Enrollment Status picklist — type + values.
  const statusField = keys.get('student_enrollment_status') ?? keys.get('student_1_enrollment_status');
  if (statusField) {
    const dt = (statusField.dataType ?? '').toUpperCase();
    if (dt !== 'SINGLE_OPTIONS' && dt !== 'RADIO') {
      items.push({
        level: 'warn',
        title: `Enrollment Status is ${dt || 'free text'} — make it a picklist`,
        detail: 'Free-text status invites typos ("unknown", "enrroled") that silently drop students off every roster. Use a picklist: Enrolled, Pending, Accepted, Waitlisted, Withdrawn, Declined.',
      });
    } else {
      const opts = Array.isArray(statusField.picklistOptions)
        ? (statusField.picklistOptions as unknown[]).map((o) => (typeof o === 'string' ? o : String((o as { name?: string })?.name ?? ''))).filter(Boolean)
        : [];
      const rogue = opts.filter((o) => !KNOWN_STATUS_VALUES.has(o.trim().toLowerCase().replace(/[\s_-]+/g, ' ')));
      if (rogue.length > 0) {
        items.push({
          level: 'warn',
          title: `Enrollment Status has unrecognized value${rogue.length === 1 ? '' : 's'}: ${rogue.join(', ')}`,
          detail: 'Students set to these values will not be counted on any roster. Rename them to Enrolled / Pending / Accepted / Waitlisted / Withdrawn / Declined (or tell us to add a mapping).',
        });
      } else if (opts.length > 0) {
        items.push({ level: 'ok', title: 'Enrollment Status picklist values all recognized', detail: opts.join(', ') });
      }
    }
  }

  // 4. Parent 2 contact-level fields.
  const p2Missing = PARENT2_FIELDS.filter((k) => !keys.has(k));
  if (p2Missing.length === 0) {
    items.push({ level: 'ok', title: 'Parent 2 fields present', detail: 'Second-guardian prefill, co-signature, and Parent-2 marketing contacts all supported.' });
  } else {
    items.push({
      level: 'warn',
      title: `Missing Parent 2 fields: ${p2Missing.join(', ')}`,
      detail: 'Without these, second-guardian prefill/writeback, enrollment co-signature routing, and Parent-2 marketing contacts degrade.',
    });
  }

  // 5. Intake items — values every school names differently. Informational
  //    by design: we standardize structure, never their grade/room names.
  const gradeField = keys.get('student_grade_level') ?? keys.get('student_1_grade_level');
  const gradeOpts = gradeField && Array.isArray(gradeField.picklistOptions)
    ? (gradeField.picklistOptions as unknown[]).map((o) => (typeof o === 'string' ? o : String((o as { name?: string })?.name ?? ''))).filter(Boolean)
    : [];
  items.push({
    level: 'info',
    title: 'Collect at intake: this school’s grade + classroom names',
    detail: (gradeOpts.length > 0
      ? `Grade values on this location: ${gradeOpts.join(', ')}. `
      : 'Grade field is free-text or empty — ask the school for their grade names. ')
      + 'Classroom/homeroom names and any roster tags are the school’s own vocabulary — record them during intake; dashboards, form targeting, and classroom hubs read whatever the contacts carry.',
  });
  items.push({
    level: 'info',
    title: 'Reserved tags',
    detail: '"parent 1", "parent 2", and "withdrawn" have platform meaning (family rostering + withdrawal marking). The school should not repurpose these tags.',
  });

  return {
    items,
    slots_detected: slotCount,
    ok: !items.some((i) => i.level === 'fail'),
  };
}
