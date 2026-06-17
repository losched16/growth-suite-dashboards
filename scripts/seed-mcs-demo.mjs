// Seed demo immunization data onto MCS's REAL roster so the Immunization
// Tracker shows realistic, varied content for the client call.
//
// Why against real students (not fabricated ones): a parallel session
// imports/refreshes the MCS roster from GHL and replaces the students
// table, which would wipe any fake rows we add. So we attach records to
// the real students that have a date of birth, selected deterministically
// by ghl_contact_id, and we DELETE+reinsert our immunization rows each run
// — making this script safe to re-run right before the call if a roster
// refresh clears it.
//
// Greenfield assumption: MCS has no real immunization data yet, so we
// reset all MCS immunization rows. Remove the reset once real data exists.
//
// Usage: node scripts/seed-mcs-demo.mjs

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scrypt = promisify(crypto.scrypt);
const DEMO_PASSWORD = 'GrowthSuite2026';

const envText = readFileSync('.env.local', 'utf8');
for (const line of envText.split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  const k = t.slice(0, eq).trim(); if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
}

const SCHOOL_ID = 'a8b6674a-2515-4f2e-9897-73a968de7fe1';
const ASOF = new Date('2026-06-17T00:00:00Z');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Standard dose ages (months) — the full K-level series + adolescent
// boosters. We emit only the doses whose target age <= the child's
// current age, producing an age-appropriate "complete" record.
const SCHEDULE = {
  dtap: [2, 4, 6, 15, 48],
  ipv:  [2, 4, 6, 48],
  hib:  [2, 4, 6, 15],
  hepb: [0, 2, 6],
  mmr:  [12, 48],
  var:  [15, 48],
  pcv:  [2, 4, 6, 15],
  tdap: [144],
  mcv:  [144],
};
function ageMonths(dobIso) {
  const dob = new Date(dobIso + 'T00:00:00Z');
  return (ASOF.getUTCFullYear() - dob.getUTCFullYear()) * 12 + (ASOF.getUTCMonth() - dob.getUTCMonth()) - (ASOF.getUTCDate() < dob.getUTCDate() ? 1 : 0);
}
function atAge(dobIso, months) {
  const d = new Date(dobIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
// Generate dose rows for a child, optionally dropping the most recent
// due dose of certain vaccines to simulate "behind".
function genDoses(dobIso, { drop = {} } = {}) {
  const am = ageMonths(dobIso);
  const out = [];
  for (const [v, ages] of Object.entries(SCHEDULE)) {
    let due = ages.filter((m) => m <= am);          // doses due by now
    const dropN = drop[v] || 0;
    if (dropN > 0) due = due.slice(0, Math.max(0, due.length - dropN));
    due.forEach((m, i) => out.push({ v, n: i + 1, date: atAge(dobIso, Math.min(m, am)) }));
  }
  return out;
}

async function main() {
  const c = await pool.connect();
  try {
    // Real students that have a usable DOB, deterministic order.
    const { rows: students } = await c.query(
      `SELECT s.id, s.first_name, s.last_name,
              COALESCE(s.date_of_birth, (s.metadata->>'date_of_birth')::date)::text AS dob
         FROM students s
        WHERE s.school_id = $1 AND s.status = 'active'
          AND COALESCE(s.date_of_birth, (s.metadata->>'date_of_birth')::date) IS NOT NULL
        ORDER BY s.metadata->>'ghl_contact_id' NULLS LAST, s.id`,
      [SCHOOL_ID],
    );
    if (students.length === 0) { console.log('No real students with a DOB found — nothing to seed.'); return; }

    await c.query('BEGIN');
    // Greenfield reset of MCS immunization rows (no real data yet).
    await c.query('DELETE FROM student_immunization_doses WHERE school_id=$1', [SCHOOL_ID]);
    await c.query('DELETE FROM student_vaccine_flags WHERE school_id=$1', [SCHOOL_ID]);
    await c.query('DELETE FROM student_immunization_profile WHERE school_id=$1', [SCHOOL_ID]);

    const counts = {};
    let seeded = 0;
    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      // Deterministic plan mix: mostly up-to-date, with a sprinkle of
      // each other status so all report categories light up.
      let plan = 'utd';
      if (i === 0 || i === 1) plan = 'religious';
      else if (i === 2) plan = 'medical';
      else if (i === 3 || i === 4) plan = 'overdue';
      else if (i === 5) plan = 'in_process';
      else if (i === 6) plan = 'no_record';
      else if (i === 7) plan = 'incomplete';
      counts[plan] = (counts[plan] || 0) + 1;

      let cert = true, exemption = 'none', inProcess = false, doses = [];
      switch (plan) {
        case 'religious': exemption = 'religious'; doses = []; break;
        case 'medical':   exemption = 'medical';   doses = []; break;
        case 'no_record': cert = false;            doses = []; break;
        case 'overdue':   doses = genDoses(s.dob, { drop: { dtap: 1, ipv: 1 } }); break;
        case 'incomplete':doses = genDoses(s.dob, { drop: { dtap: 1 } }); break;
        case 'in_process':inProcess = true; doses = genDoses(s.dob, { drop: { pcv: 1, var: 1 } }); break;
        default:          doses = genDoses(s.dob); break;   // utd
      }

      await c.query(
        `INSERT INTO student_immunization_profile (school_id, student_id, certificate_on_file, all_vaccine_exemption, in_process)
         VALUES ($1,$2,$3,$4,$5)`,
        [SCHOOL_ID, s.id, cert, exemption, inProcess],
      );
      for (const d of doses) {
        await c.query(
          `INSERT INTO student_immunization_doses (school_id, student_id, vaccine_code, dose_number, date_administered, source)
           VALUES ($1,$2,$3,$4,$5,'import')`,
          [SCHOOL_ID, s.id, d.v, d.n, d.date],
        );
      }
      seeded++;
    }

    // (Re)provision the two dashboards.
    const dashboards = [
      { slug: 'immunization', name: 'Immunization Tracker', desc: 'NC immunization tracking — classroom grid, per-child history, and the auto-filled NC Annual reports.', pos: 3,
        layout: [{ instance_id: crypto.randomUUID(), widget_id: 'student_immunizations', config: { default_room_filter: '' }, position: { x: 0, y: 0, w: 12, h: 16 } }] },
      { slug: 'document-tracker', name: 'Document Tracker', desc: 'Family-row tracker with per-student chips per form. Auto-refreshes.', pos: 4,
        layout: [{ instance_id: crypto.randomUUID(), widget_id: 'document_tracker', config: { default_form_filter: 'all', default_status_filter: 'all', auto_refresh_ms: 60000, drilldown_dashboard_slug: 'family-hub' }, position: { x: 0, y: 0, w: 12, h: 12 } }] },
    ];
    for (const d of dashboards) {
      await c.query(
        `INSERT INTO school_dashboards (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
         VALUES ($1,$2,$3,$4,$5::jsonb,true,$6)
         ON CONFLICT (school_id, dashboard_slug) DO UPDATE SET
           display_name=EXCLUDED.display_name, description=EXCLUDED.description,
           layout=EXCLUDED.layout, is_enabled=true, position=EXCLUDED.position, updated_at=now()`,
        [SCHOOL_ID, d.slug, d.name, d.desc, JSON.stringify(d.layout), d.pos],
      );
    }

    // Restore the demo parent login (roster re-syncs clear the password).
    // Pick a primary parent whose child now has immunization data.
    const demo = (await c.query(
      `SELECT p.id, p.email, f.display_name
         FROM parents p JOIN families f ON f.id = p.family_id
        WHERE p.school_id = $1 AND p.email IS NOT NULL AND p.is_primary = true
          AND EXISTS (SELECT 1 FROM student_immunization_profile ip
                        JOIN students s ON s.id = ip.student_id
                       WHERE s.family_id = f.id)
        ORDER BY p.last_name LIMIT 1`,
      [SCHOOL_ID],
    )).rows[0];
    let demoLogin = null;
    if (demo) {
      const salt = crypto.randomBytes(16).toString('hex');
      const buf = await scrypt(DEMO_PASSWORD, salt, 32);
      await c.query('UPDATE parents SET password_hash=$1, password_set_at=now() WHERE id=$2',
        [salt + ':' + buf.toString('hex'), demo.id]);
      demoLogin = { email: demo.email, family: demo.display_name };
    }

    await c.query('COMMIT');
    console.log(`Seeded immunization records for ${seeded} real students. Plan mix:`, counts);
    console.log('Provisioned dashboards: immunization, document-tracker.');
    if (demoLogin) console.log(`Demo parent login → ${demoLogin.email} / ${DEMO_PASSWORD}  (family: ${demoLogin.family})`);
  } catch (e) {
    await c.query('ROLLBACK'); throw e;
  } finally {
    c.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error('FAILED:', e.message); pool.end(); process.exit(1); });
