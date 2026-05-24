// Import Wooster's 2026-27 tuition + billing data into the dashboards
// DB. Source: the "Data for Montessori Growth" sheet (219 rows) the
// business office sent over alongside the Final Forms export.
//
// Match key: student first + last name. Writes go into the existing
// enrollments row's `metadata.tuition` blob — no new tables. This
// keeps everything queryable via the FamilyHubTable widget without a
// migration, and lets the school re-run the script when the business
// office sends an updated file.
//
// All cents. The file stores money as "$X,XXX.XX" strings (and
// "-$XXX.XX" for credits). We parse to integer cents and store as
// numbers so the dashboard can do arithmetic.
//
// Out of scope:
//   - Writing invoices to a billing table (the family-hub already
//     reads tuition off enrollments.metadata; if/when the Wooster
//     billing dashboard wants its own table we can promote)
//   - Pushing tuition figures to GHL (separate writeback task)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim();
  if (!process.env[k]) process.env[k] = v;
}

const WOOSTER_SCHOOL_ID = '2c944223-b2ad-45e1-8ba4-a4b616e4c29a';
const ACADEMIC_YEAR = '2026-27';
const FILE_PATH = process.argv.slice(2).find((a) => !a.startsWith('--'))
  || 'C:/Users/thelo/Downloads/2026-27 Montessori Enrollment Data (1).xlsx';
const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('[DRY RUN] no writes will be made');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── helpers ─────────────────────────────────────────────────────────

// Parse "$6,303.15" / "-$630.32" / "NA" / "" → integer cents (or null).
function parseCents(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toUpperCase() === 'NA' || s === '-') return null;
  // Strip $ and commas; keep sign
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function nameKey(first, last) {
  return `${(first || '').trim().toLowerCase()}|${(last || '').trim().toLowerCase()}`;
}

// "Returning in 2025/26?" answers like:
//   "Yes - We wish to attend in 2026-27"            → returning
//   "New Student - Sibling currently attending"     → new (with sibling)
//   "No - We are withdrawing" (hypothetical)        → not returning
function parseReturning(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (s.startsWith('yes')) return 'returning';
  if (s.startsWith('new')) return 'new';
  if (s.startsWith('no'))  return 'not_returning';
  return s;
}

async function main() {
  const wb = XLSX.read(readFileSync(FILE_PATH));
  const sheet = wb.Sheets['Data for Montessori Growth'];
  if (!sheet) throw new Error('expected sheet "Data for Montessori Growth"');
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  console.log(`Loaded ${rows.length} tuition rows`);

  const c = await pool.connect();
  try {
    // Load students keyed by name
    const dbStudents = (await c.query(
      `SELECT s.id, s.first_name, s.last_name, s.preferred_name
       FROM students s WHERE s.school_id = $1 AND s.status = 'active'`,
      [WOOSTER_SCHOOL_ID],
    )).rows;
    const byName = new Map();
    for (const s of dbStudents) {
      const keys = new Set([
        nameKey(s.first_name, s.last_name),
        nameKey(s.preferred_name, s.last_name),
      ].filter((k) => !k.startsWith('|')));
      for (const k of keys) {
        if (!byName.has(k)) byName.set(k, []);
        // Avoid double-pushing the same student under the same key
        // (happens when first_name === preferred_name).
        if (!byName.get(k).some((x) => x.id === s.id)) {
          byName.get(k).push(s);
        }
      }
    }

    const counts = { matched: 0, unmatched: 0, multiple: 0, updated: 0 };
    const unmatchedRows = [];

    if (!DRY_RUN) await c.query('BEGIN');

    for (const r of rows) {
      const fn = clean(r['First Name']);
      const ln = clean(r['last Name']) ?? clean(r['Last Name']);
      if (!fn || !ln) continue;

      const candidates = byName.get(nameKey(fn, ln)) ?? [];
      if (candidates.length === 0) {
        counts.unmatched++;
        unmatchedRows.push(`${fn} ${ln}`);
        continue;
      }
      if (candidates.length > 1) counts.multiple++;
      counts.matched++;

      // Build the tuition blob
      const tuition = {
        returning_status:           parseReturning(r['Returning in 2025/26?']),
        program_full_text:          clean(r['Select the program this child will attend (prices shown include deposit). Payments will be determined after payment plan and applicable credits are applied.']),
        billing_product_option:     clean(r['Billing Product Option Number']),
        discounts_description:      clean(r['Discounts']),
        payment_plan:               clean(r['Payment Plan)s)']) ?? clean(r['Payment plan']),
        applying_ed_choice:         clean(r['Are you applying for a Universal Voucher - Ed Choice (K-8 only)']),
        received_voucher_this_year: clean(r['Did your child receive a Universal Voucher during the current year?']),
        expects_voucher_balance:    clean(r['Do you expect to have a tuition balance after the Ed Choice Award? (Income above the 200% level)']),
        ed_choice_amount_cents:     parseCents(r['Based upon the Universal Voucher Income Chart, how much do you expect to receive from Ohio for next year?  ']),
        tuition_waived_cents:       parseCents(r['Tuition Amount Waived Due to 200% Poverty Level']),
        base_tuition_cents:         parseCents(r['Base Tuition Before Discounts']),
        deposit_cents:              parseCents(r['Deposits to bill - Due March1, 2025']),
        deposit_billing_status:     clean(r['Billing Status']),
        tuition_after_deposit_cents: parseCents(r['Tuition After Deposit - Before Discounts']),
        sibling_discount_cents:     parseCents(r['Sibling Discount - 10%']),
        faculty_discount_cents:     parseCents(r['Faculy Discount']),
        pif_discount_march_cents:   parseCents(r['PIF Discount (Before March 1)']),
        pif_discount_june_cents:    parseCents(r['PIF Discount (Before June 1)']),
        subtotal_after_pif_cents:   parseCents(r['Sub total with PIF']),
        amount_billed_cents:        parseCents(r['Amount \nIncludes Any\nPIF Discount\nDeposit Billed\nEarlier']),
        anticipated_voucher_billing_cents: parseCents(r['Parent Anticipated Voucher Amount - Bill in Second Pledge - Ed Choice Checks will be applied']),
        anticipated_waived_cents:   parseCents(r['Parent anticpated waived amount due to low income']),
        anticipated_parent_bill_cents: parseCents(r['Parent anticipated bill \n\nBill created for parent portion']),
        billed_status:              clean(r['Reviewed and Ready To Bill']),
        total_invoice_cents:        parseCents(r['Total  of Both Invoices EdChoice and Parent Portions\n\n']),
        total_discounts_cents:      parseCents(r['Total of All Discounts']),
        number_of_payments:         Number(r['Number of Payments']) || null,
        amount_per_12_payment_cents: parseCents(r['12 payment Amount']),
        amount_per_10_payment_cents: parseCents(r['10 payment Amount']),
        amount_pay_in_full_cents:   parseCents(r['Pay In Full \nOne Payment']),
        amount_two_payments_first_cents:  parseCents(r['Two Payments - First Payment']),
        amount_two_payments_second_cents: parseCents(r['Two Payments - Second Payment']),
        imported_at: new Date().toISOString(),
        source: 'wooster_business_office_xlsx',
      };

      // Strip null fields for compactness
      const compact = Object.fromEntries(
        Object.entries(tuition).filter(([, v]) => v !== null && v !== undefined),
      );

      // Update each matching student's enrollment (usually 1; sometimes
      // multiple if siblings have identical names — unlikely but handled).
      for (const cand of candidates) {
        if (!DRY_RUN) {
          await c.query(
            `UPDATE enrollments
                SET metadata = COALESCE(metadata, '{}'::jsonb)
                                  || jsonb_build_object('tuition', $1::jsonb),
                    updated_at = now()
              WHERE student_id = $2 AND academic_year = $3`,
            [JSON.stringify(compact), cand.id, ACADEMIC_YEAR],
          );
        }
        counts.updated++;
      }
    }

    if (!DRY_RUN) await c.query('COMMIT');

    console.log('\n=== Summary ===');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
    if (unmatchedRows.length) {
      console.log('\nUnmatched (first 20):');
      for (const n of unmatchedRows.slice(0, 20)) console.log(`  - ${n}`);
    }
  } catch (e) {
    if (!DRY_RUN) await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
