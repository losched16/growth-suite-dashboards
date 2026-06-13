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
import { loadEnrollmentShares, splitCents } from './billing-shares';

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
  // Optional per-enrollment tuition override (scholarship / financial
  // aid / custom adjustment). When provided, REPLACES the computed
  // total (grid - plan_discount + addons) and drives the installment
  // math. 0 = family owes nothing (no invoices materialized, enrollment
  // is still recorded). null/undefined = no override (compute normally).
  // The override value + reason + audit columns are persisted to
  // family_tuition_enrollments so the UI can show "Scholarship" badges
  // and the next regen picks up the same override automatically.
  tuitionOverrideCents?: number | null;
  tuitionOverrideReason?: string | null;
  // School-chosen date the FIRST installment drafts ('YYYY-MM-DD').
  // Anchors the whole schedule (monthly = +1mo each, semi = +6mo each,
  // annual/single = this date). Overrides the plan's month-day anchor.
  // null/undefined → fall back to the plan's schedule defaults.
  firstDueDate?: string | null;
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
  // Optional school-configured anchor: 'MM-DD'. When set, the first
  // installment is due on this month-day of the appropriate academic
  // year, and subsequent installments use this same day-of-month for
  // each subsequent month in the schedule.
  first_due_month_day: string | null;
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
    `SELECT slug, display_name, installment_count, discount_basis_points,
            schedule_template, first_due_month_day
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
  const computedTotal = discountedTuition + addonTotal;

  // Honor the per-enrollment override when set. 0 is a valid value
  // (scholarship — family owes nothing). null/undefined → use the
  // computed total. We don't validate amount > 0 here because the
  // scholarship case explicitly wants 0.
  const hasOverride = opts.tuitionOverrideCents != null;
  const totalAnnualCents = hasOverride
    ? Math.max(0, opts.tuitionOverrideCents!)
    : computedTotal;

  if (!hasOverride && totalAnnualCents <= 0) {
    throw new Error('Computed annual total is $0 — nothing to invoice. (Set a tuition override explicitly if you want a $0 enrollment.)');
  }
  if (plan.installment_count <= 0) {
    throw new Error('Plan has 0 installments — invalid configuration.');
  }
  // Scholarship / $0 override: skip materializing invoices entirely.
  // The enrollment row is still upserted so the family shows up in the
  // Plans tab (with a "Scholarship" badge driven by the override fields).
  const skipInvoices = hasOverride && totalAnnualCents === 0;

  // ── 4. Compute the per-installment dates ─────────────────────────────
  // A school-chosen first_due_date (absolute) anchors the schedule and
  // wins over the plan's month-day default.
  const anchor = parseAnchorDate(opts.firstDueDate);
  const dueDates = anchor
    ? datesFromAnchor(anchor, plan.schedule_template.kind, plan.installment_count)
    : computeDueDates(plan.schedule_template, opts.academicYear, plan.installment_count, plan.first_due_month_day);
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
  // Dry-run gate: when the school's billing_active flag is false, force
  // every new invoice into 'draft' status regardless of what the caller
  // asked for. Drafts don't appear in the parent portal, don't fire
  // notification emails, and are skipped by the autopay cron — the
  // school can fully verify its tuition setup against real family data
  // before any real money moves. Operator flips billing_active via the
  // Payments hub "Go live" action; existing drafts then upgrade to open.
  const { rows: cfgRows } = await query<{ billing_active: boolean; autopay_default_on: boolean }>(
    `SELECT COALESCE(billing_active, false) AS billing_active,
            COALESCE(autopay_default_on, true) AS autopay_default_on
       FROM school_payment_config WHERE school_id = $1`,
    [opts.schoolId],
  );
  const billingActive = cfgRows[0]?.billing_active ?? false;
  const initialStatus = !billingActive ? 'draft' : (opts.initialStatus ?? 'open');
  // Autopay on by default (school-configurable) — installments are
  // created autopay-enabled so the moment a family saves a card, the
  // schedule drafts automatically and the school never hand-invoices.
  const autopayOn = cfgRows[0]?.autopay_default_on ?? true;

  const result = await withTransaction(async (q) => {
    // Upsert enrollment — replaces a prior enrollment for the same
    // (family, student, year) if one exists. The override columns are
    // EXPLICITLY set (not COALESCE'd) so the operator can clear a
    // prior scholarship by passing tuitionOverrideCents=null on a
    // regen — otherwise old overrides would silently linger.
    const overrideCents = hasOverride ? opts.tuitionOverrideCents ?? null : null;
    const overrideReason = hasOverride ? (opts.tuitionOverrideReason ?? null) : null;
    const overrideSetBy = hasOverride ? opts.createdByEmail : null;

    const enrIns = await q<{ id: string }>(
      `INSERT INTO family_tuition_enrollments
         (school_id, family_id, student_id, academic_year,
          tuition_grid_id, payment_plan_id,
          annual_tuition_cents, plan_discount_basis_points, addons,
          total_annual_cents, installment_count, schedule,
          status, internal_note, created_by_email,
          tuition_override_cents, tuition_override_reason,
          tuition_override_set_by_email, tuition_override_set_at, first_due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb,
               'active', $13, $14,
               $15, $16, $17,
               CASE WHEN $15::int IS NULL THEN NULL ELSE now() END, $18)
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
         tuition_override_cents = EXCLUDED.tuition_override_cents,
         tuition_override_reason = EXCLUDED.tuition_override_reason,
         tuition_override_set_by_email = EXCLUDED.tuition_override_set_by_email,
         tuition_override_set_at = EXCLUDED.tuition_override_set_at,
         first_due_date = COALESCE(EXCLUDED.first_due_date, family_tuition_enrollments.first_due_date),
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
        overrideCents, overrideReason, overrideSetBy, opts.firstDueDate ?? null,
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

    // Scholarship / $0 override: skip the entire installment loop. The
    // enrollment row is recorded (so the family appears in the Plans
    // tab with a "Scholarship" badge driven by tuition_override_*),
    // but no invoices materialize because there's nothing to bill.
    if (skipInvoices) {
      await q(
        `UPDATE family_tuition_enrollments
            SET installments_generated_at = now(), updated_at = now()
          WHERE id = $1`,
        [enrollmentId],
      );
      return { enrollmentId, invoiceIds };
    }

    // Load split-billing shares for this enrollment ONCE up front. When
    // shares.length === 0 → joint billing (current behavior, one invoice
    // per installment to the family). When shares.length >= 1 → split
    // billing (N invoices per installment, one per parent, each scoped
    // to that parent's share + amount).
    const shares = await loadEnrollmentShares(opts.schoolId, enrollmentId, q);
    const shareBp = shares.map((s) => s.share_basis_points);
    const splitParents: Array<{ parent_id: string | null; share_label: string | null }> =
      shares.length > 0
        ? shares.map((s) => ({
            parent_id: s.parent_id,
            share_label: `${(s.parent_first_name || '').trim()} ${(s.parent_last_name || '').trim()}`.trim() || null,
          }))
        : [{ parent_id: null, share_label: null }];

    for (let i = 0; i < plan.installment_count; i++) {
      const installmentNumber = i + 1;
      const installmentCents = installmentAmounts[i];
      const dueDate = dueDates[i];

      // For split billing, partition the installment into per-parent
      // amounts that sum back to installmentCents exactly. For joint
      // billing this is a single-element array equal to installmentCents.
      const perPartyInstallment = shares.length > 0
        ? splitCents(installmentCents, shareBp)
        : [installmentCents];

      for (let p = 0; p < splitParents.length; p++) {
        const party = splitParents[p];
        const partyInstallment = perPartyInstallment[p];

        // Skip zero-share invoices entirely — no point emitting a $0
        // invoice when one parent's share is 0%. (Future case: when an
        // admin sets a parent to 0% to "show on the record but don't
        // bill them" — we just don't generate.)
        if (partyInstallment <= 0) continue;

        // Allocate invoice number (atomic increment). One sequential
        // number per emitted invoice — in split-billed mode this means
        // one number per (installment × parent) pair, which is the right
        // behavior (each parent gets a unique invoice number).
        const cfg = await q<{ prefix: string; next: number }>(
          `INSERT INTO school_payment_config (school_id) VALUES ($1)
           ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
           RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
          [opts.schoolId],
        );
        const seq = cfg.rows[0].next > 1 ? cfg.rows[0].next - 1 : 1;
        const invoiceNumber = `${cfg.rows[0].prefix}-${String(seq).padStart(6, '0')}`;

        // Pro-rate each line across this party's portion of the
        // installment so per-line totals sum to partyInstallment exactly.
        const lines = buildInstallmentLines({
          gridDisplayName: grid.display_name,
          tuitionTotal: shares.length > 0
            ? Math.round((discountedTuition * shareBp[p]) / 10000)
            : discountedTuition,
          addons: shares.length > 0
            ? selectedAddons.map((a) => ({
                ...a,
                amount_cents: Math.round((a.amount_cents * shareBp[p]) / 10000),
              }))
            : selectedAddons,
          installmentAmount: partyInstallment,
          annualTotal: shares.length > 0
            ? Math.round((totalAnnualCents * shareBp[p]) / 10000)
            : totalAnnualCents,
          installmentNumber,
          installmentCount: plan.installment_count,
        });

        // Discounts evaluation per-installment. For split billing we
        // evaluate on the party's portion so e.g. a $50 sibling discount
        // gets split proportionally (60% parent pays $30, 40% parent
        // pays $20). Same downstream policy machinery — no special case.
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

        const titleSuffix = party.share_label
          ? ` — ${party.share_label}'s share`
          : '';
        const title = `${grid.display_name} — Installment ${installmentNumber}/${plan.installment_count}${titleSuffix}`;
        const description = `${plan.display_name} · ${opts.academicYear}`;

        // 18 cols, 18 values. $1-$15 are the parameters; positions 10
        // (platform_fee_cents=0), 15 (source='tuition_plan'),
        // and 17 (includes_platform_setup_fee=false) are literals.
        const invIns = await q<{ id: string }>(
          `INSERT INTO invoices
             (school_id, family_id, student_id, responsible_parent_id,
              invoice_number, title, description,
              status, subtotal_cents, platform_fee_cents, discount_total_cents,
              total_cents, due_at, issued_at, source, source_ref,
              includes_platform_setup_fee, created_by_email,
              autopay_enabled, autopay_charge_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10,
                   $11, $12, $13, 'tuition_plan', $14::jsonb, false, $15,
                   $16, $17)
           RETURNING id`,
          [
            opts.schoolId, opts.familyId, opts.studentId, party.parent_id,
            invoiceNumber, title, description,
            initialStatus,
            subtotalCents, discountCents, totalCents,
            dueDate.toISOString(),
            initialStatus === 'open' ? new Date().toISOString() : null,
            JSON.stringify({
              enrollment_id: enrollmentId,
              installment_number: installmentNumber,
              // When split-billed, record which share index this invoice
              // came from so the admin UI can group them per-parent.
              ...(party.parent_id ? { share_parent_id: party.parent_id } : {}),
            }),
            opts.createdByEmail,
            autopayOn,
            dueDate.toISOString().slice(0, 10),
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
      } // end per-party loop
    } // end per-installment loop

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

// Parse a school-chosen 'YYYY-MM-DD' first-due date into a UTC-noon
// Date (noon dodges DST/timezone date-shift). Returns null if absent or
// malformed so the caller falls back to the plan's schedule defaults.
function parseAnchorDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Build installment due dates from an ABSOLUTE first-due anchor (the
// school's chosen first-payment date). monthly = +1 month each, semi =
// +6 months each, single/annual = the anchor itself. The day-of-month
// is clamped to each month's length (e.g. anchor 31st → Feb 28).
function datesFromAnchor(anchor: Date, kind: string, count: number): Date[] {
  const y = anchor.getUTCFullYear();
  const mo = anchor.getUTCMonth();   // 0-11
  const day = anchor.getUTCDate();
  const at = (monthsOut: number) => {
    const tgtY = y + Math.floor((mo + monthsOut) / 12);
    const tgtM = (mo + monthsOut) % 12;
    const lastDay = new Date(Date.UTC(tgtY, tgtM + 1, 0)).getUTCDate();
    return new Date(Date.UTC(tgtY, tgtM, Math.min(day, lastDay), 12, 0, 0));
  };
  if (kind === 'single') return [anchor];
  const stepMonths = kind === 'semiannual' ? 6 : 1; // monthly + fallback
  return Array.from({ length: count }, (_, i) => at(i * stepMonths));
}

// Given a payment_plans.schedule_template + academic year, return one
// Date per installment, in chronological order. Academic year is encoded
// like "2026-27" (Aug 2026 → May 2027 by convention).
//
// firstDueMonthDay (optional, 'MM-DD'): school-configured anchor for
// the first installment. When supplied, the FIRST installment is due
// on that month-day, and subsequent installments use the same
// day-of-month for each subsequent month in the schedule template.
// 'single' kind always uses the anchor as-is (or Aug 15 fallback).
function computeDueDates(
  tpl: ScheduleTemplate,
  academicYear: string,
  installmentCount: number,
  firstDueMonthDay: string | null = null,
): Date[] {
  const [startYearStr] = academicYear.split('-');
  const startYear = parseInt(startYearStr, 10);
  if (!Number.isFinite(startYear)) {
    throw new Error(`Invalid academic_year format: ${academicYear} (expected '2026-27')`);
  }

  // Parse optional anchor. Pattern is enforced by the DB CHECK constraint
  // (see migration 039) so we only re-validate format here defensively.
  let anchorMonth: number | null = null; // 1-12
  let anchorDay: number | null = null;   // 1-31
  if (firstDueMonthDay) {
    const m = /^(\d{2})-(\d{2})$/.exec(firstDueMonthDay);
    if (m) {
      anchorMonth = parseInt(m[1], 10);
      anchorDay = parseInt(m[2], 10);
      if (anchorMonth < 1 || anchorMonth > 12 || anchorDay < 1 || anchorDay > 31) {
        anchorMonth = null;
        anchorDay = null;
      }
    }
  }

  // Map a month number (1-12) to a calendar year inside the academic
  // year. The boundary is the school's academic-year start month —
  // typically August (fall-start), but MCH and some others start in
  // July. When an anchor is set we use the anchor month as the boundary;
  // otherwise we default to August (preserves the old behavior for
  // schools that never configured an anchor).
  //   months >= start → calendar year is the academic-year start year
  //   months <  start → calendar year is start + 1
  const startMonth = anchorMonth ?? 8;
  const yearOf = (month: number) => month >= startMonth ? startYear : startYear + 1;

  // Clamp day to the actual length of the month (e.g. anchor day 31
  // applied to February → 28/29). UTC noon to dodge DST edge cases.
  const dateAt = (year: number, month: number, day: number) => {
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const safeDay = Math.min(day, lastDayOfMonth);
    return new Date(Date.UTC(year, month - 1, safeDay, 12, 0, 0));
  };

  if (tpl.kind === 'single') {
    // Single annual payment: use anchor if provided, otherwise Aug 15.
    const m = anchorMonth ?? 8;
    const d = anchorDay ?? 15;
    return [dateAt(yearOf(m), m, d)];
  }

  if (tpl.kind === 'monthly' || tpl.kind === 'semiannual') {
    // If an anchor is set we re-anchor the FIRST month to the anchor
    // month and apply the anchor day across all months. Subsequent
    // months stay as defined in the template — schools usually want
    // "Aug 1, Sep 1, Oct 1..." not "Aug 1, Aug 1, Aug 1...".
    const dayOfMonth = anchorDay ?? 1;
    let months = tpl.months;

    if (anchorMonth != null) {
      // Find the anchor month in the template's months array. If
      // present, rotate so it's first. If not present, prepend it and
      // drop the original first month (keeps installment_count stable).
      const idx = months.findIndex((mm) => parseInt(mm, 10) === anchorMonth);
      if (idx > 0) {
        months = [...months.slice(idx), ...months.slice(0, idx)];
      } else if (idx === -1) {
        const padded = String(anchorMonth).padStart(2, '0');
        months = [padded, ...months.slice(0, months.length - 1)];
      }
    }

    return months.map((mm) => {
      const m = parseInt(mm, 10);
      if (!Number.isFinite(m) || m < 1 || m > 12) {
        throw new Error(`Invalid month in schedule: ${mm}`);
      }
      return dateAt(yearOf(m), m, dayOfMonth);
    });
  }

  if (tpl.kind === 'custom') {
    // Custom-date schedules ignore the anchor — explicit dates win.
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
