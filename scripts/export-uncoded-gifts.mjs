// Exports every dp_gifts row that has no campaign attribution
// (solicit_code + solicit_code_descr both null/empty) for a given
// school. Output is a CSV the operator can hand back to the school's
// development office to tag in DonorPerfect.
//
// USAGE:
//   node scripts/export-uncoded-gifts.mjs <school_id> [output_path.csv]
//
// Defaults to writing into the project Downloads-style folder next to
// the source enrichment CSV — easy to find.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const envText = readFileSync(join(projectRoot, '.env.local'), 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq === -1) continue;
  if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const schoolId = process.argv[2];
const outPath = process.argv[3] || 'C:/Users/thelo/Downloads/DGM-uncoded-gifts.csv';
if (!schoolId) {
  console.error('Usage: node scripts/export-uncoded-gifts.mjs <school_id> [output.csv]');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Pull every uncoded gift + the donor's identity + a hint at their
// "usual" campaigns (the other campaign codes attached to this donor's
// OTHER gifts). The hint helps DGM guess what this gift likely belongs
// to without opening DonorPerfect.
const { rows } = await pool.query(
  `WITH donor_known_campaigns AS (
     SELECT dp_donor_id,
            STRING_AGG(DISTINCT COALESCE(solicit_code_descr, solicit_code), ', '
                       ORDER BY COALESCE(solicit_code_descr, solicit_code))
              FILTER (WHERE solicit_code IS NOT NULL OR solicit_code_descr IS NOT NULL)
              AS known_campaigns
       FROM dp_gifts WHERE school_id = $1
      GROUP BY dp_donor_id
   )
   SELECT
     g.dp_gift_id,
     g.dp_donor_id,
     g.gift_date,
     g.amount,
     d.first_name,
     d.last_name,
     d.org_rec,
     d.email,
     d.mobile_phone,
     d.city,
     d.state,
     dkc.known_campaigns,
     d.inferred_segment
     FROM dp_gifts g
     JOIN dp_donors d
       ON d.dp_donor_id = g.dp_donor_id AND d.school_id = g.school_id
     LEFT JOIN donor_known_campaigns dkc ON dkc.dp_donor_id = g.dp_donor_id
    WHERE g.school_id = $1
      AND (g.solicit_code IS NULL OR g.solicit_code = '')
      AND (g.solicit_code_descr IS NULL OR g.solicit_code_descr = '')
    ORDER BY g.gift_date DESC NULLS LAST, g.amount DESC`,
  [schoolId],
);

// Build CSV
const headers = [
  'gift_id',
  'donor_id',
  'gift_date',
  'amount',
  'donor_name',
  'donor_type',
  'email',
  'phone',
  'city',
  'state',
  'donor_segment',
  'donor_other_campaigns_for_reference',
];
function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

const lines = [headers.join(',')];
let total = 0;
for (const r of rows) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
  total += Number(r.amount || 0);
  lines.push([
    esc(r.dp_gift_id),
    esc(r.dp_donor_id),
    esc(fmtDate(r.gift_date)),
    esc(r.amount),
    esc(name),
    esc(r.org_rec === 'Y' ? 'organization' : 'individual'),
    esc(r.email),
    esc(r.mobile_phone),
    esc(r.city),
    esc(r.state),
    esc(r.inferred_segment),
    esc(r.known_campaigns),
  ].join(','));
}
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

console.log('');
console.log('='.repeat(60));
console.log(`  EXPORTED ${rows.length} uncoded gift(s)`);
console.log('='.repeat(60));
console.log(`  Total value:      $${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Date range
const dated = rows.filter((r) => r.gift_date);
if (dated.length > 0) {
  const dates = dated.map((r) => fmtDate(r.gift_date));
  console.log(`  Date range:       ${dates[dates.length - 1]} -> ${dates[0]}`);
}

// Largest uncoded gifts (top 5) — likely the most important to tag
console.log('');
console.log('  Top 5 largest uncoded gifts:');
const byAmount = [...rows].sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)).slice(0, 5);
for (const r of byAmount) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || '(no name)';
  console.log(`    $${String(r.amount).padStart(10)}  ${fmtDate(r.gift_date)}  ${name}  (gift #${r.dp_gift_id})`);
}

console.log('');
console.log(`  File written to:  ${outPath}`);
console.log('='.repeat(60));

await pool.end();
