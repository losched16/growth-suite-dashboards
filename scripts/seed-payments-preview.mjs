// Seeds preview data for the new payments UIs (Wooster only).
//
// Idempotent — running it twice produces the same end state. Picks the
// first active Wooster family with at least one student as the "demo
// family", then creates:
//   1. A sample payment-required form ("Class trip — spring 2026")
//      with all 4 new pricing block types (pricing_select, multi_pricing,
//      quantity_pricing, tuition_calculator)
//   2. A sample OPEN invoice with multiple line items + a discount line
//      (so the parent /billing page + /billing/pay/[id] panel are populated)
//   3. Three discount_policies (one auto sibling discount, one redeemable
//      code, one fake FA award — the FA one is intentionally orphaned so
//      it shows up in the admin UI but won't actually apply)
//   4. A second "year-end statement" fixture: a few succeeded payment
//      rows in the prior calendar year so the printout has data to show
//
// Does NOT call Stripe at all. Pure DB writes.
//
// Run: node scripts/seed-payments-preview.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

// Default to Wooster, but allow override via SCHOOL_ID env or first
// argv. Also accept FAMILY_ID env to force a specific demo family
// (otherwise we pick the first active family with the most students,
// so sibling discounts trigger).
const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const SCHOOL_ID = process.env.SCHOOL_ID || process.argv[2] || WOOSTER_SCHOOL_ID;
const FORCE_FAMILY_ID = process.env.FAMILY_ID || null;
const PRIOR_YEAR = new Date().getFullYear() - 1;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const c = await pool.connect();
  try {
    // ── 0. Pick a demo family ──────────────────────────────────────────
    // Default behaviour: pick the family with the most active students
    // (so the sibling discount with min_children_enrolled=2 actually
    // applies, and the demo has a "real-looking" multi-child invoice).
    // Override with FAMILY_ID env var.
    const demoFamilySql = FORCE_FAMILY_ID
      ? `SELECT f.id, f.display_name, s.id AS student_id,
                CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student_name
           FROM families f
           JOIN students s ON s.family_id = f.id AND s.status = 'active'
          WHERE f.school_id = $1 AND f.id = $2
          ORDER BY s.created_at ASC
          LIMIT 1`
      : `SELECT f.id, f.display_name, s.id AS student_id,
                CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student_name
           FROM families f
           JOIN students s ON s.family_id = f.id AND s.status = 'active'
           JOIN (
             SELECT family_id, COUNT(*) AS n
               FROM students
              WHERE status = 'active'
              GROUP BY family_id
           ) cnt ON cnt.family_id = f.id
          WHERE f.school_id = $1
          ORDER BY cnt.n DESC, f.created_at ASC
          LIMIT 1`;
    const demoArgs = FORCE_FAMILY_ID ? [SCHOOL_ID, FORCE_FAMILY_ID] : [SCHOOL_ID];
    const { rows: fams } = await c.query(demoFamilySql, demoArgs);
    if (fams.length === 0) {
      throw new Error(`No families with active students for school ${SCHOOL_ID}.`);
    }
    const demo = fams[0];
    console.log(`Demo family: ${demo.display_name} (student: ${demo.student_name})`);

    // ── 1. Sample payment-required form ─────────────────────────────────
    const slug = 'payments-preview-class-trip';
    const fieldSchema = [
      { type: 'header', text: 'Spring Class Trip — Sign-Up & Payment' },
      { type: 'paragraph', text: 'This is a preview form showcasing all the new payment-aware field types. Make a selection in each section to see the running total update at the bottom.' },

      { type: 'section', label: 'Bus seat tier', description: 'One per student.' },
      {
        type: 'pricing_select',
        key: 'bus_tier',
        label: 'Choose a seat tier',
        required: true,
        show_price_in_label: false,
        options: [
          { value: 'standard', label: 'Standard seat',  amount_cents: 4500 },
          { value: 'window',   label: 'Window seat',    amount_cents: 5500 },
          { value: 'premium',  label: 'Front-row premium', amount_cents: 7500 },
        ],
      },

      { type: 'section', label: 'Optional add-ons' },
      {
        type: 'multi_pricing',
        key: 'addons',
        label: 'Pick any you want',
        options: [
          { value: 'lunch',    label: 'Boxed lunch',       amount_cents: 1200 },
          { value: 'tshirt',   label: 'Commemorative t-shirt', amount_cents: 1800 },
          { value: 'photo',    label: 'Group photo print', amount_cents:  900 },
        ],
      },

      { type: 'section', label: 'Extra tickets for siblings' },
      {
        type: 'quantity_pricing',
        key: 'sibling_tickets',
        label: 'Sibling tickets',
        unit_label: 'sibling ticket',
        unit_amount_cents: 3500,
        min: 0,
        max: 5,
      },

      { type: 'section', label: 'Tuition calculator (live)', description: 'Reads from Wooster\'s real tuition_grids + payment_plans.' },
      {
        type: 'tuition_calculator',
        key: 'tuition_calc',
        label: 'Annual tuition selection',
        include_plan_picker: true,
      },

      { type: 'signature_typed', key: 'parent_signature', label: 'Typed signature', required: true, acknowledgment: 'I authorize the school to charge the total shown below.' },
    ];

    const paymentConfig = {
      mode: 'required',
      invoice_title_function: null,
      invoice_title_template: 'Class trip — {student_name}',
      due_days_from_submission: 7,
      lines: [
        { kind: 'pricing_select', field_key: 'bus_tier', label_template: 'Bus — {label}', category: 'trip' },
        { kind: 'multi_pricing',  field_key: 'addons', category: 'trip' },
        { kind: 'quantity_pricing', field_key: 'sibling_tickets', label: 'Sibling tickets', category: 'trip' },
        { kind: 'tuition_calculator', field_key: 'tuition_calc', category: 'tuition' },
      ],
    };

    await c.query(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          required_for, field_schema, ghl_writeback, fee_amount,
          one_submission_per_year, resubmission_allowed, needs_review,
          is_active, payment_config)
       VALUES ($1, $2, $3, $4, 'event', true, NULL, $5::jsonb, '[]'::jsonb,
               NULL, false, true, false, true, $6::jsonb)
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description  = EXCLUDED.description,
         field_schema = EXCLUDED.field_schema,
         payment_config = EXCLUDED.payment_config,
         updated_at   = now()`,
      [
        SCHOOL_ID, slug,
        'Class trip — preview',
        'Preview form for the new payment-aware field types. Safe to play with; submissions create real invoices.',
        JSON.stringify(fieldSchema),
        JSON.stringify(paymentConfig),
      ],
    );
    console.log(`Form created/updated: /forms-v2/${slug}`);

    // ── 1b. Dedicated Tuition Enrollment form ─────────────────────────
    // Single-purpose form that's ONLY the tuition calculator. This is
    // the cleanest demo of "parent picks program + plan + addons → sees
    // live annual total + per-installment math." Reads the school's
    // real tuition_grids + payment_plans, computes live as the parent
    // makes selections.
    const tuitionSlug = 'tuition-enrollment-2026-27';
    const tuitionFieldSchema = [
      { type: 'header', text: 'Tuition Enrollment — 2026-27' },
      {
        type: 'paragraph',
        text: 'Choose your child\'s program, then pick a payment plan and any add-ons. Your annual total and monthly amount will calculate automatically below.',
      },
      {
        type: 'tuition_calculator',
        key: 'tuition_selection',
        label: 'Program, plan, and add-ons',
        required: true,
        include_plan_picker: true,
      },
      {
        type: 'signature_typed',
        key: 'parent_signature',
        label: 'Typed signature (parent / guardian)',
        required: true,
        acknowledgment:
          'I authorize the school to invoice my family for the tuition selection above, on the schedule shown by the selected payment plan.',
      },
      {
        type: 'date',
        key: 'signature_date',
        label: 'Date',
        required: true,
        prefill: 'today',
      },
    ];
    const tuitionPaymentConfig = {
      mode: 'required',
      invoice_title_template: 'Tuition — {student_name} (2026-27)',
      due_days_from_submission: 0,
      lines: [
        { kind: 'tuition_calculator', field_key: 'tuition_selection', category: 'tuition' },
      ],
    };
    await c.query(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          required_for, field_schema, ghl_writeback, fee_amount,
          one_submission_per_year, resubmission_allowed, needs_review,
          is_active, payment_config)
       VALUES ($1, $2, $3, $4, 'enrollment', true, NULL, $5::jsonb, '[]'::jsonb,
               NULL, false, true, false, true, $6::jsonb)
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description  = EXCLUDED.description,
         field_schema = EXCLUDED.field_schema,
         payment_config = EXCLUDED.payment_config,
         updated_at   = now()`,
      [
        SCHOOL_ID, tuitionSlug,
        'Tuition Enrollment 2026-27',
        'Clean demo of the auto-calculating tuition selector — picks program + plan + addons, computes annual + per-installment live.',
        JSON.stringify(tuitionFieldSchema),
        JSON.stringify(tuitionPaymentConfig),
      ],
    );
    console.log(`Form created/updated: /forms-v2/${tuitionSlug}`);

    // ── 2. Sample open invoice with mixed lines + a discount ───────────
    // Allocate an invoice number atomically.
    const { rows: cfgRows } = await c.query(
      `INSERT INTO school_payment_config (school_id) VALUES ($1)
       ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
       RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
      [SCHOOL_ID],
    );
    const seq = cfgRows[0].next > 1 ? cfgRows[0].next - 1 : 1;
    const previewInvoiceNumber = `${cfgRows[0].prefix}-PREVIEW-${String(seq).padStart(4, '0')}`;

    // Delete any prior preview invoice for this family to keep idempotent.
    await c.query(
      `DELETE FROM invoices WHERE school_id = $1 AND family_id = $2 AND invoice_number LIKE $3`,
      [SCHOOL_ID, demo.id, '%-PREVIEW-%'],
    );

    const invoiceLines = [
      { description: 'Bus — Window seat',            quantity: 1, unit: 5500, category: 'trip' },
      { description: 'Boxed lunch',                  quantity: 1, unit: 1200, category: 'trip' },
      { description: 'Commemorative t-shirt',        quantity: 1, unit: 1800, category: 'trip' },
      { description: 'Sibling tickets',              quantity: 2, unit: 3500, category: 'trip' },
    ];
    const subtotalCents = invoiceLines.reduce((s, l) => s + l.quantity * l.unit, 0);
    const discountCents = Math.round(subtotalCents * 0.10); // 10% sibling discount preview
    const totalCents = subtotalCents - discountCents; // no platform fee on preview

    const { rows: [{ id: invoiceId }] } = await c.query(
      `INSERT INTO invoices
         (school_id, family_id, student_id, invoice_number, title, description,
          status, subtotal_cents, platform_fee_cents, discount_total_cents,
          total_cents, due_at, issued_at, source, includes_platform_setup_fee,
          created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 0, $8, $9, now() + interval '7 days', now(),
               'manual', false, 'preview-seed@growthsuite.local')
       RETURNING id`,
      [
        SCHOOL_ID, demo.id, demo.student_id,
        previewInvoiceNumber,
        `Preview — Spring class trip for ${demo.student_name}`,
        'Sample invoice created by the preview seeder. Safe to delete.',
        subtotalCents, discountCents, totalCents,
      ],
    );

    let pos = 0;
    for (const l of invoiceLines) {
      await c.query(
        `INSERT INTO invoice_line_items
           (invoice_id, position, description, quantity, unit_amount_cents,
            amount_cents, category, student_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [invoiceId, pos++, l.description, l.quantity, l.unit, l.quantity * l.unit, l.category, demo.student_id],
      );
    }
    // Discount as a negative line item so /billing/pay shows it.
    await c.query(
      `INSERT INTO invoice_line_items
         (invoice_id, position, description, quantity, unit_amount_cents,
          amount_cents, category, student_id)
       VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
      [invoiceId, pos++, 'Sibling discount (10% off trip)', -discountCents, 'discount', demo.student_id],
    );
    console.log(`Invoice created: ${previewInvoiceNumber} (id=${invoiceId})`);

    // ── 3. Three discount policies ─────────────────────────────────────
    // Wipe any prior preview discounts to stay idempotent.
    await c.query(
      `DELETE FROM discount_policies
        WHERE school_id = $1 AND display_name LIKE 'PREVIEW —%'`,
      [SCHOOL_ID],
    );

    await c.query(
      `INSERT INTO discount_policies
         (school_id, kind, display_name, percentage_basis_points, amount_cents,
          applies_to_categories, conditions, is_active)
       VALUES
         ($1, 'auto', 'PREVIEW — Multi-child sibling discount', 1000, 0, $2, $3::jsonb, true),
         ($1, 'code', 'PREVIEW — WELCOME50 (10%)', 1000, 0, '{}', '{}'::jsonb, true)`,
      [SCHOOL_ID, ['tuition', 'trip'], JSON.stringify({ min_children_enrolled: 2 })],
    );
    // Set the code on the second row
    await c.query(
      `UPDATE discount_policies SET redemption_code = 'WELCOME50', max_total_redemptions = 100, max_redemptions_per_family = 1
        WHERE school_id = $1 AND display_name = 'PREVIEW — WELCOME50 (10%)'`,
      [SCHOOL_ID],
    );
    console.log('Discount policies seeded (2x preview).');

    // ── 3b. Wooster tuition grids + payment plans (idempotent) ────────
    // Two grids: Toddler + Primary. Each carries some required + optional
    // addons. Two plans: Annual (single pay) + 10-pay monthly.
    const ACADEMIC_YEAR = '2026-27';

    // Plans
    await c.query(
      `INSERT INTO payment_plans
         (school_id, slug, display_name, description, installment_count,
          discount_basis_points, schedule_template, is_active, position)
       VALUES
         ($1, 'annual', 'Annual (single payment)', 'Pay once in August. Save 3%.', 1,
          300, '{"kind":"single"}'::jsonb, true, 1),
         ($1, '10-pay', '10-pay (August–May)', 'One payment on the 1st of each month, Aug through May.', 10,
          0, '{"kind":"monthly","months":["08","09","10","11","12","01","02","03","04","05"]}'::jsonb, true, 2)
       ON CONFLICT (school_id, slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         installment_count = EXCLUDED.installment_count,
         discount_basis_points = EXCLUDED.discount_basis_points,
         schedule_template = EXCLUDED.schedule_template,
         is_active = true,
         updated_at = now()`,
      [SCHOOL_ID],
    );

    // Grids
    await c.query(
      `INSERT INTO tuition_grids
         (school_id, academic_year, program, grade_level, display_name,
          annual_tuition_cents, addons, is_active, position)
       VALUES
         ($1, $2, 'Toddler', NULL, 'Toddler Program (M–F, full day)',
          1320000, $3::jsonb, true, 1),
         ($1, $2, 'Primary', NULL, 'Primary Program (Ages 3–6, full day)',
          1450000, $4::jsonb, true, 2)
       ON CONFLICT (school_id, academic_year, program, grade_level) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         annual_tuition_cents = EXCLUDED.annual_tuition_cents,
         addons = EXCLUDED.addons,
         is_active = true,
         updated_at = now()`,
      [
        SCHOOL_ID, ACADEMIC_YEAR,
        JSON.stringify([
          { key: 'before_care', label: 'Before Care (7am–8am)', amount_cents:  80000 },
          { key: 'after_care',  label: 'After Care (3pm–6pm)',  amount_cents: 120000 },
          { key: 'lunch',       label: 'Hot Lunch Program',     amount_cents:  60000, required: false },
          { key: 'enrollment_deposit', label: 'Re-enrollment deposit (non-refundable)', amount_cents: 25000, required: true },
        ]),
        JSON.stringify([
          { key: 'before_care', label: 'Before Care (7am–8am)', amount_cents:  90000 },
          { key: 'after_care',  label: 'After Care (3pm–6pm)',  amount_cents: 130000 },
          { key: 'enrichment',  label: 'Spanish enrichment (Tue/Thu)', amount_cents:  45000 },
          { key: 'enrollment_deposit', label: 'Re-enrollment deposit (non-refundable)', amount_cents: 25000, required: true },
        ]),
      ],
    );
    console.log('Seeded 2 tuition grids + 2 payment plans for Wooster.');

    // ── 3b2. Paid enrollment-deposit invoice (idempotent) ─────────────
    // Simulates the parent having signed their enrollment contract and
    // paid the non-refundable deposit. When they later fill out the
    // tuition-enrollment form, the calculator sees this as paid and
    // shows it as a credit rather than charging again.
    await c.query(
      `DELETE FROM payments
        WHERE school_id = $1 AND family_id = $2
          AND stripe_payment_intent_id = 'pi_preview_deposit'`,
      [SCHOOL_ID, demo.id],
    );
    await c.query(
      `DELETE FROM invoices
        WHERE school_id = $1 AND family_id = $2
          AND invoice_number LIKE '%-DEPOSIT-%'`,
      [SCHOOL_ID, demo.id],
    );
    const depositPaidAt = new Date(Date.UTC(2026, 2, 15)).toISOString(); // March 15 = signing day
    const depositInvNumber = `WOO-DEPOSIT-${String(Date.now()).slice(-4)}`;
    const { rows: depInv } = await c.query(
      `INSERT INTO invoices
         (school_id, family_id, student_id, invoice_number, title, description,
          status, subtotal_cents, platform_fee_cents, discount_total_cents,
          total_cents, amount_paid_cents, due_at, issued_at, paid_at,
          source, includes_platform_setup_fee, created_by_email)
       VALUES ($1, $2, $3, $4, 'Re-enrollment deposit (2026-27)',
               'Paid at enrollment-contract signing. Counts as credit on tuition.',
               'paid', 25000, 0, 0, 25000, 25000, $5, $5, $5,
               'manual', false, 'preview-seed@growthsuite.local')
       RETURNING id`,
      [SCHOOL_ID, demo.id, demo.student_id, depositInvNumber, depositPaidAt],
    );
    await c.query(
      `INSERT INTO invoice_line_items
         (invoice_id, position, description, quantity, unit_amount_cents,
          amount_cents, category, student_id)
       VALUES ($1, 0, 'Re-enrollment deposit (non-refundable)', 1, 25000, 25000,
               'enrollment_deposit', $2)`,
      [depInv[0].id, demo.student_id],
    );
    await c.query(
      `INSERT INTO payments
         (school_id, invoice_id, family_id, stripe_payment_intent_id,
          stripe_payment_method_type, amount_cents, fee_cents, status,
          created_at, updated_at)
       VALUES ($1, $2, $3, 'pi_preview_deposit', 'card', 25000, 1025, 'succeeded', $4, $4)`,
      [SCHOOL_ID, depInv[0].id, demo.id, depositPaidAt],
    );
    console.log(`Seeded paid enrollment-deposit invoice (${depositInvNumber}) so the calculator shows it as a credit.`);

    // ── 3c. Active enrollment for the demo family ─────────────────────
    // Wipe any prior preview enrollment + its generated invoices so this
    // is repeatable.
    const { rows: priorEnroll } = await c.query(
      `SELECT id FROM family_tuition_enrollments
        WHERE school_id = $1 AND family_id = $2 AND academic_year = $3`,
      [SCHOOL_ID, demo.id, ACADEMIC_YEAR],
    );
    for (const e of priorEnroll) {
      await c.query(
        `DELETE FROM invoices
          WHERE source = 'tuition_plan' AND source_ref->>'enrollment_id' = $1`,
        [e.id],
      );
    }
    await c.query(
      `DELETE FROM family_tuition_enrollments
        WHERE school_id = $1 AND family_id = $2 AND academic_year = $3`,
      [SCHOOL_ID, demo.id, ACADEMIC_YEAR],
    );

    // Look up the Primary grid + 10-pay plan we just created.
    const { rows: gridRows } = await c.query(
      `SELECT id, annual_tuition_cents, addons FROM tuition_grids
        WHERE school_id = $1 AND academic_year = $2 AND program = 'Primary' LIMIT 1`,
      [SCHOOL_ID, ACADEMIC_YEAR],
    );
    const { rows: planRows } = await c.query(
      `SELECT id, installment_count, discount_basis_points, schedule_template
         FROM payment_plans
        WHERE school_id = $1 AND slug = '10-pay' LIMIT 1`,
      [SCHOOL_ID],
    );
    const grid = gridRows[0];
    const plan = planRows[0];

    // Compute totals: full tuition (no plan discount on 10-pay) + the
    // required enrollment deposit + 'after_care' add-on.
    const selectedAddons = (grid.addons ?? []).filter((a) =>
      a.required || a.key === 'after_care',
    );
    const addonTotal = selectedAddons.reduce((s, a) => s + a.amount_cents, 0);
    const totalAnnualCents = grid.annual_tuition_cents + addonTotal;

    const { rows: enrIns } = await c.query(
      `INSERT INTO family_tuition_enrollments
         (school_id, family_id, student_id, academic_year,
          tuition_grid_id, payment_plan_id,
          annual_tuition_cents, plan_discount_basis_points, addons,
          total_annual_cents, installment_count, schedule,
          status, internal_note, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb,
               'active', 'Seeded for preview', 'preview-seed@growthsuite.local')
       RETURNING id`,
      [
        SCHOOL_ID, demo.id, demo.student_id, ACADEMIC_YEAR,
        grid.id, plan.id,
        grid.annual_tuition_cents, plan.discount_basis_points,
        JSON.stringify(selectedAddons.map((a) => ({ key: a.key, label: a.label, amount_cents: a.amount_cents }))),
        totalAnnualCents, plan.installment_count,
        JSON.stringify(plan.schedule_template),
      ],
    );
    const enrollmentId = enrIns[0].id;

    // Generate the 10 monthly installment invoices manually (mirrors the
    // generator's logic — we can't import TS into a .mjs script easily).
    const months = ['08','09','10','11','12','01','02','03','04','05'];
    const baseInstallment = Math.floor(totalAnnualCents / 10);
    const remainder = totalAnnualCents - baseInstallment * 10;
    for (let i = 0; i < 10; i++) {
      const installmentNumber = i + 1;
      const installmentCents = i === 9 ? baseInstallment + remainder : baseInstallment;
      const mm = months[i];
      const m = parseInt(mm, 10);
      const startYear = parseInt(ACADEMIC_YEAR.split('-')[0], 10);
      const y = m >= 8 ? startYear : startYear + 1;
      const dueDate = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));

      // Pro-rate tuition + addons across the installment.
      const tuitionFrac = grid.annual_tuition_cents / totalAnnualCents;
      const tuitionPortion = Math.round(installmentCents * tuitionFrac);
      let used = tuitionPortion;
      const lineRows = [
        { description: 'Primary Program — Tuition', amount: tuitionPortion, category: 'tuition' },
      ];
      for (let j = 0; j < selectedAddons.length; j++) {
        const a = selectedAddons[j];
        const frac = a.amount_cents / totalAnnualCents;
        let portion = Math.round(installmentCents * frac);
        used += portion;
        if (j === selectedAddons.length - 1) {
          portion += installmentCents - used;
        }
        lineRows.push({ description: a.label, amount: portion, category: 'tuition_addon' });
      }

      // Allocate invoice number
      const { rows: cfgR } = await c.query(
        `INSERT INTO school_payment_config (school_id) VALUES ($1)
         ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
         RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
        [SCHOOL_ID],
      );
      const seq = cfgR[0].next > 1 ? cfgR[0].next - 1 : 1;
      const invoiceNumber = `${cfgR[0].prefix}-${String(seq).padStart(6, '0')}`;

      // First three months marked paid so the parent /plan page shows
      // real progress; the rest open.
      const isPastMonth = dueDate < new Date();
      const status = isPastMonth ? 'paid' : 'open';
      const paidCents = isPastMonth ? installmentCents : 0;
      const paidAt = isPastMonth ? dueDate.toISOString() : null;

      const { rows: invR } = await c.query(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title, description,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, amount_paid_cents, due_at, issued_at, paid_at,
            source, source_ref, includes_platform_setup_fee, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $8, $9, $10, $11, $12,
                 'tuition_plan', $13::jsonb, false, 'preview-seed@growthsuite.local')
         RETURNING id`,
        [
          SCHOOL_ID, demo.id, demo.student_id,             // $1, $2, $3
          invoiceNumber,                                            // $4
          `Primary Program — Installment ${installmentNumber}/10`,  // $5
          `10-pay (August–May) · ${ACADEMIC_YEAR}`,                 // $6
          status,                                                   // $7
          installmentCents,                                         // $8 (subtotal_cents + total_cents reuse)
          paidCents,                                                // $9  → amount_paid_cents
          dueDate.toISOString(),                                    // $10 → due_at
          dueDate.toISOString(),                                    // $11 → issued_at
          paidAt,                                                   // $12 → paid_at
          JSON.stringify({ enrollment_id: enrollmentId, installment_number: installmentNumber }), // $13
        ],
      );
      let pos = 0;
      for (const ln of lineRows) {
        await c.query(
          `INSERT INTO invoice_line_items
             (invoice_id, position, description, quantity, unit_amount_cents,
              amount_cents, category, student_id)
           VALUES ($1, $2, $3, 1, $4, $4, $5, $6)`,
          [invR[0].id, pos++, ln.description, ln.amount, ln.category, demo.student_id],
        );
      }
      // For paid months, drop a successful payment row too so the
      // PaymentsOverview widget shows non-zero MTD/YTD.
      if (isPastMonth) {
        await c.query(
          `INSERT INTO payments
             (school_id, invoice_id, family_id, stripe_payment_intent_id,
              stripe_payment_method_type, amount_cents, fee_cents, status,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'us_bank_account', $5, $6, 'succeeded', $7, $7)`,
          [
            SCHOOL_ID, invR[0].id, demo.id,
            `pi_preview_enroll_${enrollmentId}_${installmentNumber}`,
            installmentCents,
            Math.min(500, Math.round(installmentCents * 0.008)),
            dueDate.toISOString(),
          ],
        );
      }
    }
    await c.query(
      `UPDATE family_tuition_enrollments
          SET installments_generated_at = now(), updated_at = now()
        WHERE id = $1`,
      [enrollmentId],
    );
    console.log(`Seeded active enrollment + 10 installment invoices for ${demo.display_name} (some paid, some upcoming).`);

    // ── 4. Year-end statement fixtures ─────────────────────────────────
    // Wipe any prior preview payments/invoices for this family so we don't
    // accumulate fakes across runs.
    await c.query(
      `DELETE FROM payments
        WHERE school_id = $1 AND family_id = $2
          AND stripe_payment_intent_id LIKE 'pi_preview_%'`,
      [SCHOOL_ID, demo.id],
    );
    await c.query(
      `DELETE FROM invoices
        WHERE school_id = $1 AND family_id = $2
          AND invoice_number LIKE '%-PRIOR-%'`,
      [SCHOOL_ID, demo.id],
    );

    // Create 4 prior-year invoices + matching succeeded payments so the
    // year-end statement page has rows to show.
    const priorYearLines = [
      { month:  1, title: 'Tuition — January',  cents: 285000, category: 'tuition' },
      { month:  4, title: 'Tuition — April',    cents: 285000, category: 'tuition' },
      { month:  8, title: 'Enrollment deposit', cents:  50000, category: 'enrollment_deposit' },
      { month: 10, title: 'Fall field trip',    cents:   4500, category: 'trip' },
    ];
    for (let i = 0; i < priorYearLines.length; i++) {
      const l = priorYearLines[i];
      const paidAt = new Date(Date.UTC(PRIOR_YEAR, l.month - 1, 15)).toISOString();
      const num = `WOO-PRIOR-${String(i + 1).padStart(3, '0')}`;
      const { rows: [{ id: invId }] } = await c.query(
        `INSERT INTO invoices
           (school_id, family_id, student_id, invoice_number, title,
            status, subtotal_cents, platform_fee_cents, discount_total_cents,
            total_cents, due_at, issued_at, paid_at, source,
            includes_platform_setup_fee, created_by_email)
         VALUES ($1, $2, $3, $4, $5, 'paid', $6, 0, 0, $6, $7, $7, $7,
                 'manual', false, 'preview-seed@growthsuite.local')
         RETURNING id`,
        [SCHOOL_ID, demo.id, demo.student_id, num, l.title, l.cents, paidAt],
      );
      await c.query(
        `INSERT INTO invoice_line_items
           (invoice_id, position, description, quantity, unit_amount_cents,
            amount_cents, category, student_id)
         VALUES ($1, 0, $2, 1, $3, $3, $4, $5)`,
        [invId, l.title, l.cents, l.category, demo.student_id],
      );
      await c.query(
        `INSERT INTO payments
           (school_id, invoice_id, family_id, stripe_payment_intent_id,
            stripe_payment_method_type, amount_cents, fee_cents, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'us_bank_account', $5, $6, 'succeeded', $7, $7)`,
        [SCHOOL_ID, invId, demo.id, `pi_preview_${invId}`, l.cents, Math.min(500, Math.round(l.cents * 0.008)), paidAt],
      );
    }
    console.log(`Seeded ${priorYearLines.length} prior-year (${PRIOR_YEAR}) paid invoices for year-end statement.`);

    // Resolve a parent on the demo family so we can echo a login hint.
    const { rows: parentRows } = await c.query(
      `SELECT email FROM parents
        WHERE family_id = $1 AND email IS NOT NULL AND status = 'active'
        ORDER BY is_primary DESC LIMIT 1`,
      [demo.id],
    );

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('Seed complete. Suggested URLs to visit:');
    console.log('  Admin payments page:');
    console.log(`    /admin/${SCHOOL_ID}/payments`);
    console.log('  PaymentsOverview widget (drop onto any Wooster dashboard with widget id "payments_overview")');
    console.log('  Parent portal (sign in as):');
    console.log(`    ${parentRows[0]?.email ?? '(no active parent email on file)'}`);
    console.log('  Then visit:');
    console.log(`    /billing             — outstanding invoice list (shows preview invoice + 10-pay installments)`);
    console.log(`    /billing/plan        — NEW: payment plan view with installment schedule + progress bar`);
    console.log(`    /billing/pay/${invoiceId}  — payment screen with discount line`);
    console.log(`    /billing/year-end-statement?year=${PRIOR_YEAR}  — populated tax printout`);
    console.log(`    /forms-v2/${slug}    — pricing form with all 4 new field types`);
    console.log(`    /forms-v2/tuition-enrollment-2026-27  — CLEAN auto-calc tuition demo`);
    console.log('──────────────────────────────────────────────────────────\n');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
