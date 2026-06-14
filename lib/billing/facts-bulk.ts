// Bulk tuition scheduling from imported FACTS data.
//
// The school is migrating from FACTS: students are enrolled, the FACTS
// ledger is imported (facts_transactions), and each family already chose
// a payment frequency (stored on the student as metadata.payment_plan).
// This plans — and on commit, creates — one tuition enrollment +
// installment schedule per student, using the FACTS amount as the annual
// total and anchoring every schedule to a single school-chosen first
// payment date (e.g. July 1). Reuses the standard generator so autopay,
// the schedule anchor, and invoice shape all match the normal flow.
//
// planFactsBulk() is read-only (drives the preview). The caller commits
// by looping the ready rows through generateTuitionEnrollment().

import { query } from '@/lib/db';

export type AmountBasis = 'net' | 'remaining';

export interface FactsBulkRow {
  student_id: string;
  family_id: string;
  student_name: string;
  family_label: string;
  program: string | null;
  plan_label: string;            // what FACTS/the record says
  plan_id: string | null;        // resolved Growth Suite payment plan
  resolved_plan_label: string | null;
  installment_count: number;
  grid_id: string | null;
  amount_cents: number;          // annual total to schedule (from FACTS)
  ready: boolean;
  reason?: string;               // why it's skipped (when !ready)
}

export interface FactsBulkPlan {
  rows: FactsBulkRow[];
  ready_count: number;
  skipped_count: number;
  total_amount_cents: number;
}

// Map the family's recorded plan text → a Growth Suite payment_plans row.
function matchPlan(
  raw: string | null,
  plans: Array<{ id: string; display_name: string; installment_count: number }>,
): { id: string; display_name: string; installment_count: number } | null {
  const t = (raw ?? '').toLowerCase();
  const byCount = (n: number) => plans.find((p) => p.installment_count === n)
    ?? (n >= 10 ? plans.find((p) => p.installment_count >= 10) : undefined)
    ?? null;
  if (t.includes('month')) return byCount(10);
  if (t.includes('semi')) return byCount(2);
  if (t.includes('annual') || t.includes('year')) return byCount(1);
  return null;
}

// Student program_name → tuition_grids grade_level (display only; the
// FACTS amount overrides the grid price). Toddler + Primary share a grid.
function gradeForProgram(program: string | null): string | null {
  if (!program) return null;
  const p = program.trim().toLowerCase();
  if (p === 'toddler' || p === 'primary') return 'Toddler/Primary';
  return program.trim();
}

export async function planFactsBulk(
  schoolId: string,
  opts: { amountBasis: AmountBasis; academicYear: string },
): Promise<FactsBulkPlan> {
  const [students, facts, plans, grids] = await Promise.all([
    query<{
      id: string; family_id: string; student_name: string; family_label: string;
      program: string | null; plan_text: string | null;
    }>(
      `SELECT s.id, s.family_id,
              CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student_name,
              COALESCE(NULLIF(f.display_name, ''), '(unnamed)') AS family_label,
              s.metadata->>'program_name' AS program,
              s.metadata->>'payment_plan' AS plan_text
         FROM students s JOIN families f ON f.id = s.family_id
        WHERE s.school_id = $1 AND s.status = 'active'
        ORDER BY s.last_name, s.first_name`,
      [schoolId],
    ),
    query<{ student_id: string; net_charges_cents: number; remaining_balance_cents: number }>(
      `SELECT student_id, net_charges_cents, remaining_balance_cents
         FROM facts_transactions
        WHERE school_id = $1 AND academic_year = $2 AND student_id IS NOT NULL`,
      [schoolId, opts.academicYear],
    ),
    query<{ id: string; display_name: string; installment_count: number }>(
      `SELECT id, display_name, installment_count FROM payment_plans
        WHERE school_id = $1 AND is_active = true ORDER BY installment_count`,
      [schoolId],
    ),
    query<{ id: string; grade_level: string; display_name: string }>(
      `SELECT id, grade_level, display_name FROM tuition_grids
        WHERE school_id = $1 AND is_active = true AND academic_year = $2
        ORDER BY position`,
      [schoolId, opts.academicYear],
    ),
  ]);

  // FACTS amount per student (sum across split-household ledgers).
  const amtByStudent = new Map<string, number>();
  for (const f of facts.rows) {
    const v = opts.amountBasis === 'remaining' ? f.remaining_balance_cents : f.net_charges_cents;
    amtByStudent.set(f.student_id, (amtByStudent.get(f.student_id) ?? 0) + (v ?? 0));
  }
  // First grid per grade level (prefer a "School Day" grid when several).
  const gridByGrade = new Map<string, { id: string }>();
  for (const g of grids.rows) {
    const cur = gridByGrade.get(g.grade_level);
    if (!cur || /school day/i.test(g.display_name)) gridByGrade.set(g.grade_level, { id: g.id });
  }

  const rows: FactsBulkRow[] = students.rows.map((s) => {
    const base: FactsBulkRow = {
      student_id: s.id, family_id: s.family_id, student_name: s.student_name,
      family_label: s.family_label, program: s.program,
      plan_label: s.plan_text ?? '', plan_id: null, resolved_plan_label: null,
      installment_count: 0, grid_id: null, amount_cents: 0, ready: false,
    };
    const amount = amtByStudent.get(s.id) ?? 0;
    if (!amtByStudent.has(s.id)) return { ...base, reason: 'No FACTS ledger imported' };
    if (amount <= 0) return { ...base, amount_cents: amount, reason: 'Nothing owed (amount is $0)' };
    const plan = matchPlan(s.plan_text, plans.rows);
    if (!plan) return { ...base, amount_cents: amount, reason: s.plan_text ? `Unrecognized plan "${s.plan_text}"` : 'No payment plan on record' };
    const grade = gradeForProgram(s.program);
    const grid = grade ? gridByGrade.get(grade) : undefined;
    if (!grid) return { ...base, amount_cents: amount, resolved_plan_label: plan.display_name, installment_count: plan.installment_count, reason: `No tuition grid for grade "${grade ?? '(none)'}"` };
    return {
      ...base, amount_cents: amount, plan_id: plan.id,
      resolved_plan_label: plan.display_name, installment_count: plan.installment_count,
      grid_id: grid.id, ready: true,
    };
  });

  const ready = rows.filter((r) => r.ready);
  return {
    rows,
    ready_count: ready.length,
    skipped_count: rows.length - ready.length,
    total_amount_cents: ready.reduce((s, r) => s + r.amount_cents, 0),
  };
}
