// Creates a family_tuition_enrollments row + materializes the
// installment invoices for the academic year.
//
// Inputs come from the admin "Set up payment plan" form:
//   schoolId, familyId, studentId (optional but typical), academicYear,
//   tuitionGridId, paymentPlanId, addonKeys (string[]),
//   sendNow (open vs. draft), createdByEmail.
//
// Output: { enrollmentId, invoiceIds: string[] }.
//
// Discount handling: each generated invoice runs through
// evaluateDiscounts() independently so auto-apply policies + FA awards
// land on every installment (e.g. a 10% sibling discount is taken off
// each monthly bill, not just the first).
//
// All amounts in INTEGER cents.

import { query, withTransaction } from '@/lib/db';
import { evaluateDiscounts, recordDiscountApplications } from './discounts';

interface AddonSnap { key: string; label: string; amount_cents: number }

interface GenerateOpts {
  schoolId: string;
  familyId: string;
  studentId: string | null;
  academicYear: string;            // '2026-27'
  tuitionGridId: string;
  paymentPlanId: string;
  addonKeys: string[];             // selected addon keys
  internalNote?: string;
  createdByEmail: string;
  // 'open' → parent sees them immediately, 'draft' → operator must send.
  initialStatus?: 'open' | 'draft';
}

interface GenerateResult {
  enrollment_id: string;
  invoice_ids: string[];
  total_annual_cents: number;
  installment_count: number;
}

interface GridRow {
  annual_tuition_cents: number;
  display_name: string;
  addons: Array<{ key: string; label: string; amount_cents: number; required?: boolean }> | null;
}
interface PlanRow {
  slug: string;
  display_name: string;
  installment_count: number;
  discount_basis_points: number;
  schedule_template: ScheduleTemplate;
}
type ScheduleTemplate =
  | { kind: 'single' }
  | { kind: 'monthly';    months: string[] }
  | { kind: 'semiannual'; months: string[] }
  | { kind: 'custom';     dates: string[] };

export async function generateTuitionEnrollment(opts: GenerateOpts): Promise<GenerateResult> {
  // ── 1. Load the catalog rows ──────────────────────────────────────────
  const { rows: gridRows } = await query<GridRow>(
    `SELECT annual_tuition_cents, display_name, addons
       FROM tuition_grids
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [opts.tuitionGridId, opts.schoolId],
  );
  const grid = gridRows[0];
  if (!grid) throw new Error('Tuition grid not found or inactive');

  const { rows: planRows } = await query<PlanRow>(
    `SELECT slug, display_name, installment_count, discount_basis_points, schedule_template
       FROM payment_plans
      WHERE id = $1 AND school_id = $2 AND is_active = true`,
    [opts.paymentPlanId, opts.schoolId],
  );
  const plan = planRows[0];
  if (!plan) throw new Error('Payment plan not found or inactive');

  // ── 2. Resolve the chosen addons + the captured snapshot ─────────────
  const availableAddons = Array.isArray(grid.addons) ? grid.addons : [];
  // Always include any addons marked required, even if the operator
  // didn't tick them.
  const addonKeySet = new Set(opts.addonKeys);
  for (const a of availableAddons) {
    if (a.required) addonKeySet.add(a.key);
  }
  const selectedAddons: AddonSnap[] = availableAddons
    .filter((a) => addonKeySet.has(a.key))
    .map((a) => ({ key: a.key, label: a.label, amount_cents: a.amount_cents }));

  // ── 3. Compute amounts ───────────────────────────────────────────────
  const discountedTuition = grid.annual_tuition_cents
    - Math.round(grid.annual_tuition_cents * plan.discount_basis_points / 10000);
  const addonTotal = selectedAddons.reduce((s, a) => s + a.amount_cents, 0);
  const totalAnnualCents = discountedTuition + addonTotal;

  if (totalAnnualCents <= 0) {
    throw new Error('Computed annual total is $0 — nothing to invoice.');
  }
  if (plan.installment_count <= 0) {
    throw new Error('Plan has 0 installments — invalid configuration.');
  }

  // ── 4. Compute the per-installment dates ─────────────────────────────
  const dueDates = computeDueDates(plan.schedule_template, opts.academicYear, plan.installment_count);
  if (dueDates.length !== plan.installment_count) {
    throw new Error(`Plan installment_count (${plan.installment_count}) doesn't match generated schedule (${dueDates.length} dates).`);
  }

  // ── 5. Split totalAnnualCents across installments, putting any
  //       remainder on the LAST one (so the family always pays the exact
  //       discounted annual total, no rounding loss).
  const baseInstallmentCents = Math.floor(totalAnnualCents / plan.installment_count);
  const remainder = totalAnnualCents - baseInstallmentCents * plan.installment_count;
  const installmentAmounts = Array.from({ length: plan.installment_count }, (_, i) =>
    i === plan.installment_count - 1 ? baseInstallmentCents + remainder : baseInstallmentCents,
  );

  // Per-line-item split: tuition is the bulk, addons spread proportionally.
  // Simplest model: one tuition line per installment + one line per addon
  // per installment, each scaled by (installment_amount / total).
  // Cleaner alternative for v1: just one combined "Tuition" line + per-addon
  // lines that show the ANNUAL amount on the FIRST installment only. That
  // mismatches per-month math, so we instead pro-rate addons per installment.

  // ── 6. Create the enrollment row + all the invoices in one txn ───────
  const initialStatus = opts.initialStatus ?? 'open';

  const result = await withTransaction(async (q) => {
    // Upsert enrollment — replaces a prior enrollment for the same
    // (family, student, year) if one exists.
    const enrIns = await q<{ id: string }>(
      `INSERT INTO family_tuition_enrollments
         (school_id, family_id, student_id, academic_year,
          tuition_grid_id, payment_plan_id,
          annual_tuition_cents, plan_discount_basis_points, addons,
          total_annual_cents, installment_count, schedule,
          status, internal_note, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb,
               'active', $13, $14)
       ON CONFLICT (school_id, family_id, student_id, academic_year)
       DO UPDATE SET
         tuition_grid_id = EXCLUDED.tuition_grid_id,
         payment_plan_id = EXCLUDED.payment_plan_id,
         annual_tuition_cents = EXCLUDED.annual_tuition_cents,
         plan_discount_basis_points = EXCLUDED.plan_discount_basis_points,
         addons = EXCLUDED.addons,
         total_annual_cents = EXCLUDED.total_annual_cents,
         installment_count = EXCLUDED.installment_count,
         schedule = EXCLUDED.schedule,
         status = 'active',
         internal_note = COALESCE(EXCLUDED.internal_note, family_tuition_enrollments.internal_note),
         updated_at = now()
       RETURNING id`,
      [
        opts.schoolId, opts.familyId, opts.studentId, opts.academicYear,
        opts.tuitionGridId, opts.paymentPlanId,
        grid.annual_tuition_cents, plan.discount_basis_points,
        JSON.stringify(selectedAddons),
        totalAnnualCents, plan.installment_count,
        JSON.stringify(plan.schedule_template),
        opts.internalNote ?? null,
        opts.createdByEmail,
      ],
    );
    const enrollmentId = enrIns.rows[0].id;

    // Delete any prior auto-generated invoices for this enrollment that
    // are still in DRAFT or OPEN (parent hasn't paid them yet). Paid /
    // partially-paid invoices are preserved.
    await q(
      `DELETE FROM invoices
        WHERE source = 'tuition_plan'
          AND source_ref->>'enrollment_id' = $1
          AND status IN ('draft', 'open')`,
      [enrollmentId],
    );

    const invoiceIds: string[] = [];

    for (let i = 0; i < plan.installment_count; i++) {
      const installmentNumber = i + 1;
      const installmentCents = installmentAmounts[i];
      const dueDate = dueDates[i];

      // Allocate invoice number (atomic increment, just like the manual
      // route). One sequential number per installment.
      const cfg = await q<{ prefix: string; next: number }>(
        `INSERT INTO school_payment_config (school_id) VALUES ($1)
         ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
         RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
        [opts.schoolId],
      );
      const seq = cfg.rows[0].next > 1 ? cfg.rows[0].next - 1 : 1;
      const invoiceNumber = `${cfg.rows[0].prefix}-${String(seq).padStart(6, '0')}`;

      // Pro-rate each line across the installment so per-line totals sum
      // to the installment amount exactly.
      const lines = buildInstallmentLines({
        gridDisplayName: grid.display_name,
        tuitionTotal: discountedTuition,
        addons: selectedAddons,
        installmentAmount: installmentCents,
        annualTotal: totalAnnualCents,
        installmentNumber,
        installmentCount: plan.installment_count,
      });

      // Discounts evaluation per-installment (so e.g. a 10% sibling
      // discount comes off each invoice, not just the first).
      const discountResult = await evaluateDiscounts({
        schoolId: opts.schoolId,
        familyId: opts.familyId,
        studentId: opts.studentId,
        lines: lines.map((l) => ({
          description: l.description,
          amount_cents: l.amount_cents,
          category: l.category,
        })),
      });
      const subtotalCents = lines.reduce((s, l) => s + l.amount_cents, 0);
      const discountCents = discountResult.total_cents;
      const totalCents = Math.max(0, subtotalCents - discountCents);

      const title = `${grid.display_name} — Installment ${installmentNumber}/${plan.installment_count}`;
      const description = `${plan.display_name} · ${opts.academicYear}`;

      const invIns = await q<{ id: string }>(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, due_at, issued_at, source, source_ref,
            includes_platform_setup_fee, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12,
                 'tuition_plan', $13::jsonb, false, $14)
         RETURNING id`,
        [
          opts.schoolId, opts.familyId, opts.studentId,
          invoiceNumber, title, description,
          initialStatus,
          subtotalCents, discountCents, totalCents,
          dueDate.toISOString(),
          initialStatus === 'open' ? new Date().toISOString() : null,
          JSON.stringify({ enrollment_id: enrollmentId, installment_number: installmentNumber }),
          opts.createdByEmail,
        ],
      );
      const invoiceId = invIns.rows[0].id;
      invoiceIds.push(invoiceId);

      // Positive lines
      let pos = 0;
      for (const l of lines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invoiceId, pos++, l.description, l.amount_cents, l.category, opts.studentId],
        );
      }
      // Discount lines
      for (const d of discountResult.lines) {
        await q(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invoiceId, pos++, d.description, d.amount_cents, d.category, opts.studentId],
        );
      }
      await recordDiscountApplications(
        opts.schoolId, opts.familyId, invoiceId, discountResult.applications, q,
      );
    }

    await q(
      `UPDATE family_tuition_enrollments
          SET installments_generated_at = now(), updated_at = now()
        WHERE id = $1`,
      [enrollmentId],
    );

    return { enrollmentId, invoiceIds };
  });

  return {
    enrollment_id: result.enrollmentId,
    invoice_ids: result.invoiceIds,
    total_annual_cents: totalAnnualCents,
    installment_count: plan.installment_count,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface LineDraft {
  description: string;
  amount_cents: number;
  category: string;
}

function buildInstallmentLines(opts: {
  gridDisplayName: string;
  tuitionTotal: number;
  addons: AddonSnap[];
  installmentAmount: number;
  annualTotal: number;
  installmentNumber: number;
  installmentCount: number;
}): LineDraft[] {
  const lines: LineDraft[] = [];
  // For installments, we show a single combined "tuition" line scaled
  // to the installment fraction. Addons are listed separately so the
  // line categories ('tuition' vs the addon's own category) work with
  // category-targeted discount policies (sibling discount on tuition,
  // for example, leaves addons untouched).
  const tuitionFrac = opts.annualTotal > 0 ? opts.tuitionTotal / opts.annualTotal : 1;
  const tuitionPortion = Math.round(opts.installmentAmount * tuitionFrac);
  let used = tuitionPortion;
  lines.push({
    description: `${opts.gridDisplayName} — Tuition`,
    amount_cents: tuitionPortion,
    category: 'tuition',
  });
  for (let i = 0; i < opts.addons.length; i++) {
    const a = opts.addons[i];
    const frac = opts.annualTotal > 0 ? a.amount_cents / opts.annualTotal : 0;
    let portion = Math.round(opts.installmentAmount * frac);
    used += portion;
    // Push any rounding remainder onto the last addon so the lines sum
    // back to installmentAmount exactly.
    if (i === opts.addons.length - 1) {
      portion += opts.installmentAmount - used;
      used = opts.installmentAmount;
    }
    if (portion === 0) continue;
    lines.push({
      description: a.label,
      amount_cents: portion,
      category: 'tuition_addon',
    });
  }
  // If addons array was empty we already have just the tuition line —
  // adjust for rounding.
  if (opts.addons.length === 0 && tuitionPortion !== opts.installmentAmount) {
    lines[0].amount_cents = opts.installmentAmount;
  }
  return lines;
}

// Given a payment_plans.schedule_template + academic year, return one
// Date per installment, in chronological order. Academic year is encoded
// like "2026-27" (Aug 2026 → May 2027 by convention).
function computeDueDates(
  tpl: ScheduleTemplate,
  academicYear: string,
  installmentCount: number,
): Date[] {
  const [startYearStr] = academicYear.split('-');
  const startYear = parseInt(startYearStr, 10);
  if (!Number.isFinite(startYear)) {
    throw new Error(`Invalid academic_year format: ${academicYear} (expected '2026-27')`);
  }

  if (tpl.kind === 'single') {
    // Single annual payment due Aug 15 of the start year.
    return [new Date(Date.UTC(startYear, 7, 15))];
  }

  if (tpl.kind === 'monthly' || tpl.kind === 'semiannual') {
    return tpl.months.map((mm) => {
      const m = parseInt(mm, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) {
        throw new Error(`Invalid month in schedule: ${mm}`);
      }
      // Months 8–12 → start year; months 1–7 → start year + 1.
      const y = m >= 8 ? startYear : startYear + 1;
      // Due on the 1st of each month at noon UTC (avoids tz edge cases).
      return new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
    });
  }

  if (tpl.kind === 'custom') {
    return tpl.dates.map((s) => {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid custom date: ${s}`);
      return d;
    });
  }

  // Fallback (shouldn't reach if installment_count matches)
  void installmentCount;
  throw new Error(`Unknown schedule kind: ${(tpl as { kind: string }).kind}`);
}
