// Seed realistic FA applications for DGM across all statuses so the
// admin queue + per-application detail look populated for a partner
// walkthrough.
//
// Idempotent: deletes prior demo FA applications + supporting files
// before re-seeding so you can iterate. Identifies demo rows by a
// tagged decision_note / parent_notes prefix.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const DGM = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const YEAR = '2026-27';
const DEMO_TAG = '[FA DEMO]';
const APPLY = !process.argv.includes('--dry-run');

// A tiny "PDF-ish" placeholder so the inbox shows file attachments
// without us having to ship real PDFs. Lexi can preview / download
// in the UI; they'll see this as a 1-page Hello World document.
const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (Sample FA Document) Tj ET\nendstream endobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000110 00000 n \n0000000189 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n278\n%%EOF\n', 'utf8');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function findFamily(displayName) {
  const r = await pool.query(
    `SELECT id, display_name FROM families WHERE school_id = $1 AND display_name = $2 LIMIT 1`,
    [DGM, displayName],
  );
  if (r.rows.length === 0) throw new Error(`Family not found: ${displayName}`);
  return r.rows[0];
}

async function studentsForFamily(familyId) {
  const r = await pool.query(
    `SELECT id, first_name, last_name FROM students WHERE family_id = $1 AND status='active' ORDER BY first_name`,
    [familyId],
  );
  return r.rows;
}

// ── Four demo applications, one per status ────────────────────────
const APPLICATIONS = [
  {
    label: 'Johnson Family — Submitted (fresh, awaiting review)',
    family: 'Johnson Family',
    status: 'submitted',
    submitted_days_ago: 1,
    responses: {
      family: {
        household_size: 6,
        marital_status: 'married_joint',
        recent_change: 'no',
        parents: [
          { first_name: 'Michelle', last_name: 'Johnson', dob: '1984-04-12', phone: '(602) 555-0142', occupation: 'Physical therapist', employer: 'Phoenix Children\'s Hospital', has_disability: 'no' },
          { first_name: 'Adam',     last_name: 'Johnson', dob: '1982-09-30', phone: '(602) 555-0188', occupation: 'Software engineer', employer: 'Honeywell',                   has_disability: 'no' },
        ],
        family_notes: 'Stable household for the past 5 years.',
      },
      dependents: { dependents: [] },
      income: {
        has_filed_taxes: 'yes',
        federal_agi: 142500,
        federal_taxable_income: 116200,
        w2_adult_1: 92000,
        w2_adult_2: 48000,
        self_employed_income: 3500,
        dividend_interest_income: 720,
        capital_gains: 0,
        rental_income: 0,
        trust_inheritance_income: 0,
        alimony_received: 0,
        child_support_received: 0,
        gifts_received: 0,
        other_income: 0,
        income_notes: 'Adult 2 took an unpaid leave for 6 weeks last summer — gross is lower than typical year.',
      },
      real_estate: {
        housing_type: 'own_with_mortgage',
        monthly_mortgage_payment: 2950,
        annual_mortgage_interest: 14400,
        annual_property_tax: 4200,
        property_tax_in_mortgage: 'yes',
        homeowner_insurance_in_mortgage: 'yes',
        mortgage_balance: 312000,
        home_market_value: 525000,
        has_refinanced: 'no',
        other_properties: [],
      },
      vehicles: {
        vehicles: [
          { make_model: 'Honda Odyssey', year: '2020', estimated_value: 22000, outstanding_loan: 9500,  monthly_payment: 420 },
          { make_model: 'Toyota Camry',  year: '2018', estimated_value: 14500, outstanding_loan: 3200,  monthly_payment: 270 },
        ],
      },
      assets: {
        checking_total: 8400,
        savings_total: 10000,
        cd_total: 0,
        money_market_total: 0,
        stocks_bonds_securities: 12000,
        retirement_total: 145000,
        business_assets: 0,
        trust_assets: 0,
        other_tangible_assets: 0,
        student_529_total: 18500,
        children_social_security: 0,
      },
      liabilities: {
        credit_card_balance: 8400,
        personal_loans: 0,
        student_loans_adults: 23000,
        equity_loans: 0,
        annual_equity_interest: 0,
        medical_debt: 0,
        other_liabilities: 0,
      },
      expenses: {
        annual_homeowner_insurance: 0,    // in mortgage
        annual_life_insurance: 1800,
        annual_auto_insurance: 2400,
        annual_health_insurance: 8200,
        annual_medical_oop: 6200,
        annual_electricity: 2400,
        annual_heating_gas: 0,
        annual_utilities_phone_internet: 3000,
        annual_federal_taxes_paid: 18400,
        annual_state_local_taxes_paid: 4800,
        annual_childcare_other: 14400,
        annual_charity: 4200,
        annual_other_loan_payments: 0,
        annual_other_expenses: 720,
      },
      final: {
        special_circumstances: 'Younger child has unusual medical OOP this year (~$11K) due to dental work and physical therapy. The 6-week unpaid leave also reduced household income noticeably.',
        parent_notes_final: 'Thank you for considering our application. The kids love DGM and we are committed to making it work.',
      },
    },
    studentRequests: [
      { firstName: 'Harlan',  tuition: 18500, ask: 4500 },
      { firstName: 'Corbin',  tuition: 18500, ask: 4500 },
      { firstName: 'Arlo',    tuition: 14200, ask: 3500 },
      { firstName: 'Eli',     tuition: 14200, ask: 3500 },
    ],
    files: [
      { document_type: 'tax_return', filename: 'Johnson_1040_2025.pdf' },
      { document_type: 'w2', filename: 'Johnson_W2_Adult1.pdf' },
      { document_type: 'w2', filename: 'Johnson_W2_Adult2.pdf' },
      { document_type: 'pay_stubs', filename: 'Johnson_PayStubs_Sep_Oct.pdf' },
      { document_type: 'bank_statement', filename: 'Johnson_Chase_Statement.pdf' },
    ],
  },
  {
    label: 'Alami Family — Under review (mid-review by Lexi)',
    family: 'Alami Family',
    status: 'under_review',
    submitted_days_ago: 7,
    review_started_days_ago: 2,
    review_started_by: 'lexi@desertgardenmontessori.org',
    responses: {
      household: { household_size: 4, marital_status: 'married_joint', other_dependents_count: 0, recent_change: 'yes', recent_change_detail: 'Father was laid off in March and is currently consulting part-time.' },
      income: { w2_adult_1: 41000, w2_adult_2: 78000, self_employed_income: 18000, dividend_interest_income: 410, capital_gains: 0, rental_income: 0, support_received: 0, other_income: 0, has_filed_taxes: 'yes' },
      real_estate: { housing_type: 'own_with_mortgage', monthly_housing_cost: 2400, mortgage_balance: 280000, home_market_value: 450000, has_other_real_estate: 'no' },
      assets: { checking_savings: 9200, investments: 6800, retirement: 87000, vehicles_count: 2, vehicles_monthly_payment: 540 },
      debts_expenses: { credit_card_balance: 11500, monthly_debt_service: 380, monthly_health_insurance: 720, annual_medical_oop: 3200, annual_childcare: 6500 },
      final: { special_circumstances: 'Layoff in March cut household income by ~30%. Consulting is rebuilding but not at prior level yet.' },
    },
    studentRequests: [
      { firstName: 'Mae',   tuition: 18500, ask: 6500 },
      { firstName: 'Malek', tuition: 14200, ask: 5000 },
      { firstName: 'Zain',  tuition: 14200, ask: 5000 },
    ],
    files: [
      { document_type: 'tax_return', filename: 'Alami_1040_2025.pdf' },
      { document_type: 'w2', filename: 'Alami_W2.pdf' },
      { document_type: 'pay_stubs', filename: 'Alami_Consulting_Invoices.pdf' },
      { document_type: 'bank_statement', filename: 'Alami_Wells_Fargo.pdf' },
    ],
    admin_notes: 'Income transition warrants extra weight. Will review with committee Tuesday.',
  },
  {
    label: 'Boxill Family — Decided (full award letter)',
    family: 'Boxill Family',
    status: 'decided',
    submitted_days_ago: 21,
    review_started_days_ago: 14,
    review_started_by: 'lexi@desertgardenmontessori.org',
    decided_days_ago: 4,
    decided_by: 'lexi@desertgardenmontessori.org',
    responses: {
      household: { household_size: 5, marital_status: 'single', other_dependents_count: 1, recent_change: 'yes', recent_change_detail: 'Single parent supporting an elderly mother who moved in last year.' },
      income: { w2_adult_1: 58000, self_employed_income: 0, dividend_interest_income: 240, support_received: 14400, other_income: 0, has_filed_taxes: 'yes' },
      real_estate: { housing_type: 'rent', monthly_housing_cost: 1850 },
      assets: { checking_savings: 4200, investments: 0, retirement: 32000, vehicles_count: 1, vehicles_monthly_payment: 320 },
      debts_expenses: { credit_card_balance: 6800, monthly_debt_service: 240, monthly_health_insurance: 410, annual_medical_oop: 8400, annual_childcare: 2400 },
      final: { special_circumstances: 'Significant medical OOP for elderly mother. Single income supporting 5 people.' },
    },
    studentRequests: [
      { firstName: 'Jaxon',   tuition: 18500, ask: 9500, recommended_award: 9000, award_note: 'Full requested aid less $500 — approved by committee.' },
      { firstName: 'Jayla',   tuition: 14200, ask: 7500, recommended_award: 7000, award_note: 'Award reflects sibling discount + financial profile.' },
      { firstName: 'Jaylani', tuition: 14200, ask: 7500, recommended_award: 7000, award_note: 'Award reflects sibling discount + financial profile.' },
    ],
    files: [
      { document_type: 'tax_return', filename: 'Boxill_1040_2025.pdf' },
      { document_type: 'w2', filename: 'Boxill_W2.pdf' },
      { document_type: 'pay_stubs', filename: 'Boxill_PayStubs.pdf' },
      { document_type: 'bank_statement', filename: 'Boxill_BoA_Statement.pdf' },
      { document_type: 'medical_expenses', filename: 'Boxill_MedicalReceipts.pdf' },
    ],
    decision_note: 'The committee was moved by the dedication this family shows to all three children. We are honored to support them.',
    admin_notes: 'Award totals $23,000 — committee unanimous. Letter sent.',
  },
  {
    label: 'Hill Family — Draft (mid-wizard, parent stopped at step 4)',
    family: 'Hill Family',
    status: 'draft',
    wizard_step: 4,
    responses: {
      household: { household_size: 5, marital_status: 'married_joint', other_dependents_count: 0, recent_change: 'no' },
      income: { w2_adult_1: 76000, w2_adult_2: 64000, has_filed_taxes: 'yes' },
      real_estate: { housing_type: 'own_with_mortgage', monthly_housing_cost: 2680 },
    },
    studentRequests: [
      { firstName: 'Andrew',    tuition: 18500, ask: 3500 },
      { firstName: 'Katherine', tuition: 14200, ask: 2500 },
    ],
    files: [],
  },
];

async function reset(client) {
  console.log(`\n  Resetting demo FA applications for DGM (tag: ${DEMO_TAG})…`);
  // Find demo apps to wipe (matched by our DEMO_TAG prefix in any text col)
  const r = await client.query(
    `SELECT id FROM fa_applications WHERE school_id = $1 AND (
        parent_notes LIKE $2 OR decision_note LIKE $2
        OR special_circumstances LIKE $2)`,
    [DGM, `%${DEMO_TAG}%`],
  );
  for (const row of r.rows) {
    await client.query(`DELETE FROM fa_application_files WHERE application_id = $1`, [row.id]);
    await client.query(`DELETE FROM fa_application_students WHERE application_id = $1`, [row.id]);
    await client.query(`DELETE FROM fa_applications WHERE id = $1`, [row.id]);
  }
  // Also wipe anything against the four demo families' fa_applications for 2026-27
  for (const def of APPLICATIONS) {
    const fam = await findFamily(def.family).catch(() => null);
    if (!fam) continue;
    const e = await client.query(`SELECT id FROM fa_applications WHERE school_id=$1 AND family_id=$2 AND academic_year=$3`, [DGM, fam.id, YEAR]);
    for (const ex of e.rows) {
      await client.query(`DELETE FROM fa_application_files WHERE application_id = $1`, [ex.id]);
      await client.query(`DELETE FROM fa_application_students WHERE application_id = $1`, [ex.id]);
      await client.query(`DELETE FROM fa_applications WHERE id = $1`, [ex.id]);
    }
  }
  console.log('  Reset complete.');
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (APPLY) await reset(client);

    for (const def of APPLICATIONS) {
      const fam = await findFamily(def.family);
      const students = await studentsForFamily(fam.id);
      console.log(`\n  Seeding: ${def.label}`);
      console.log(`    Family ${fam.display_name} (${fam.id})`);
      console.log(`    Students: ${students.map((s) => s.first_name).join(', ')}`);

      // Roll up flat numeric fields from the responses (mirrors the
      // save-draft endpoint's extractor).
      const income = def.responses.income ?? {};
      const assets = def.responses.assets ?? {};
      const incomeSum = ['w2_adult_1','w2_adult_2','self_employed_income','dividend_interest_income','capital_gains','rental_income','support_received','other_income']
        .map((k) => Number(income[k] ?? 0)).reduce((s, n) => s + n, 0);
      const assetsSum = ['checking_savings','investments','retirement','cd_money_market','business_equity','other_assets']
        .map((k) => Number(assets[k] ?? 0)).reduce((s, n) => s + n, 0);
      const householdSize = Number(def.responses.household?.household_size ?? 0) || null;

      // Per-student totals
      const totalTuition  = def.studentRequests.reduce((s, r) => s + (r.tuition ?? 0), 0);
      const totalRequested = def.studentRequests.reduce((s, r) => s + (r.ask ?? 0), 0);
      const totalAward = def.studentRequests.reduce((s, r) => s + (r.recommended_award ?? 0), 0) || null;

      // Tag the parent_notes so reset() can find this row later.
      const taggedSpecial = `${DEMO_TAG} ${def.responses.final?.special_circumstances ?? ''}`.trim();
      const taggedNotes = `${DEMO_TAG} ${def.responses.final?.parent_notes_final ?? ''}`.trim();

      const submittedAt = def.submitted_days_ago != null
        ? new Date(Date.now() - def.submitted_days_ago * 86400_000).toISOString()
        : null;
      const reviewStartedAt = def.review_started_days_ago != null
        ? new Date(Date.now() - def.review_started_days_ago * 86400_000).toISOString()
        : null;
      const decidedAt = def.decided_days_ago != null
        ? new Date(Date.now() - def.decided_days_ago * 86400_000).toISOString()
        : null;

      const { rows: ins } = await client.query(
        `INSERT INTO fa_applications (
           school_id, family_id, academic_year,
           household_size, total_annual_income, assets_value,
           current_tuition_owed, requested_aid,
           special_circumstances, parent_notes,
           status, submitted_at,
           review_started_at, review_started_by,
           decided_at, decided_by,
           decision_note,
           recommended_award,
           responses, wizard_step, last_saved_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,now())
         RETURNING id`,
        [
          DGM, fam.id, YEAR,
          householdSize, incomeSum || null, assetsSum || null,
          totalTuition || null, totalRequested || null,
          taggedSpecial, taggedNotes,
          def.status, submittedAt,
          reviewStartedAt, def.review_started_by ?? null,
          decidedAt, def.decided_by ?? null,
          def.decision_note ? `${DEMO_TAG} ${def.decision_note}` : null,
          totalAward,
          JSON.stringify(def.responses),
          def.wizard_step ?? 7,
        ],
      );
      const appId = ins[0].id;

      // Match student requests to actual student IDs by first name
      let matched = 0;
      for (const req of def.studentRequests) {
        const s = students.find((st) => st.first_name.toLowerCase() === req.firstName.toLowerCase());
        if (!s) { console.log(`    (skipping ${req.firstName} — not in family)`); continue; }
        await client.query(
          `INSERT INTO fa_application_students
             (application_id, student_id, current_tuition, requested_aid, recommended_award, award_note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [appId, s.id, req.tuition ?? null, req.ask ?? null, req.recommended_award ?? null, req.award_note ?? null],
        );
        matched++;
      }
      console.log(`    Per-student rows: ${matched}`);

      // Files
      for (const f of def.files) {
        await client.query(
          `INSERT INTO fa_application_files
             (application_id, school_id, document_type, display_name, original_filename,
              mime_type, size_bytes, contents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [appId, DGM, f.document_type, f.filename, f.filename, 'application/pdf', SAMPLE_PDF.length, SAMPLE_PDF],
        );
      }
      console.log(`    Files: ${def.files.length}`);
    }

    if (APPLY) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    console.log(`\n  ${APPLY ? 'Committed' : 'Dry-run only'}. ${APPLICATIONS.length} applications seeded.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('  Seed failed (rolled back):', e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((e) => { console.error(e); process.exit(1); });
