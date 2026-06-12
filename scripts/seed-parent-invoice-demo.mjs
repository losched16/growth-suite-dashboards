// One-off: seed 2 open invoices on DGM's Carter (DEMO) family so a
// parent login shows real invoices in /billing for a demo call.
//   node --env-file=.env.local scripts/seed-parent-invoice-demo.mjs

import pg from 'pg';
import crypto from 'node:crypto';

const SCHOOL_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const FAMILY_ID = 'cdf70975-b0a4-4f3a-8a34-2858bfffe750';

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// A student to attribute line items to (Mia Carter), best-effort.
const stu = (await c.query(
  `SELECT id FROM students WHERE family_id = $1 AND status = 'active' ORDER BY first_name LIMIT 1`,
  [FAMILY_ID],
)).rows[0]?.id ?? null;

const invoices = [
  {
    title: 'October Tuition',
    description: 'Monthly tuition for October',
    lines: [{ description: 'Monthly Tuition — October', qty: 1, unit: 85000, category: 'tuition' }],
  },
  {
    title: 'Field Trip — Desert Botanical Garden',
    description: 'Optional spring field trip',
    lines: [{ description: 'Field trip fee (transport + entry)', qty: 1, unit: 3500, category: 'activity' }],
  },
];

const out = [];
for (const inv of invoices) {
  // prefix + next number, atomically bump
  const cfg = (await c.query(
    `INSERT INTO school_payment_config (school_id) VALUES ($1)
     ON CONFLICT (school_id) DO UPDATE SET next_invoice_number = school_payment_config.next_invoice_number + 1
     RETURNING invoice_number_prefix AS prefix, next_invoice_number AS next`,
    [SCHOOL_ID],
  )).rows[0];
  const seq = cfg.next > 1 ? cfg.next - 1 : 1;
  const invoiceNumber = `${cfg.prefix}-${String(seq).padStart(6, '0')}`;

  const subtotal = inv.lines.reduce((s, l) => s + l.qty * l.unit, 0);
  const token = crypto.randomBytes(18).toString('hex');
  const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const r = await c.query(
    `INSERT INTO invoices
       (school_id, family_id, student_id, invoice_number, title, description,
        status, subtotal_cents, platform_fee_cents, discount_total_cents,
        total_cents, due_at, issued_at, source, includes_platform_setup_fee,
        created_by_email, public_pay_token)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,0,0,$7,$8,now(),'manual',false,
             'demo-seed@growthsuite.local',$9)
     RETURNING id`,
    [SCHOOL_ID, FAMILY_ID, stu, invoiceNumber, inv.title, inv.description, subtotal, dueAt, token],
  );
  const invoiceId = r.rows[0].id;
  let pos = 0;
  for (const l of inv.lines) {
    await c.query(
      `INSERT INTO invoice_line_items
         (invoice_id, position, description, quantity, unit_amount_cents, amount_cents, category, student_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invoiceId, pos++, l.description, l.qty, l.unit, l.qty * l.unit, l.category, stu],
    );
  }
  out.push({ invoiceNumber, title: inv.title, total: `$${(subtotal / 100).toFixed(2)}`, invoiceId, token });
}

console.log('Seeded invoices for Carter (DEMO) family:');
for (const o of out) {
  console.log(`  ${o.invoiceNumber} · ${o.title} · ${o.total}`);
  console.log(`    pay link: /pay/invoice/${o.invoiceId}?t=${o.token}`);
}
await c.end();
