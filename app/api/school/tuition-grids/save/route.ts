// POST /api/school/tuition-grids/save
//
// School-iframe CRUD for tuition_grids. Replaces the per-school custom
// seed scripts (seed-mch-tuition.mjs, _reseed_dgm_tuition.mjs, etc.) for
// day-to-day grid management. School session auth — same model as the
// rest of /api/school/*.
//
// Body (form-encoded):
//   op = 'add' | 'update' | 'deactivate' | 'reactivate'
//   plus the relevant fields per op.
//
// On success: 303 redirect to return_to (or default) with ?msg=…
// On error:   303 redirect with ?err=…

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounce(request: NextRequest, returnTo: string | null, qs: { msg?: string; err?: string }) {
  const fallback = '/school/_/payments?tab=grids';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (qs.msg) url.searchParams.set('msg', qs.msg);
  if (qs.err) url.searchParams.set('err', qs.err);
  return NextResponse.redirect(url, 303);
}

function dollarsToCents(raw: string): number {
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

// A rate-card add-on (extended day, hot lunch, materials fee, etc.). Stored
// on tuition_grids.addons as jsonb and consumed by the enrollment generator
// (lib/billing/tuition-plan-generator.ts — shape: {key,label,amount_cents,
// required?}). `key` is the stable id the enrollment snapshot ticks; we
// derive it from the label but persist it in a hidden field so renaming a
// label on a later edit keeps the same key.
interface AddonInput { key: string; label: string; amount_cents: number; required: boolean }

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'addon';
}

// The Add-ons editor renders a fixed set of slots (addon_label_0..N,
// addon_amount_0..N, addon_required_0..N, addon_key_0..N). We parse every
// slot with a non-empty label and replace the grid's whole addons array.
const ADDON_SLOTS = 8;
function parseAddons(fd: FormData): AddonInput[] {
  const out: AddonInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ADDON_SLOTS; i++) {
    const label = String(fd.get(`addon_label_${i}`) ?? '').trim();
    if (!label) continue; // empty slot — skip
    const amount_cents = dollarsToCents(String(fd.get(`addon_amount_${i}`) ?? ''));
    const required = String(fd.get(`addon_required_${i}`) ?? '').trim() !== '';
    let key = String(fd.get(`addon_key_${i}`) ?? '').trim() || slugify(label);
    while (seen.has(key)) key = `${key}_${i}`; // guarantee uniqueness within the grid
    seen.add(key);
    out.push({ key, label, amount_cents, required });
  }
  return out;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const op = String(fd.get('op') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;

  try {
    if (op === 'add') {
      const academicYear = String(fd.get('academic_year') ?? '').trim();
      const program      = String(fd.get('program') ?? '').trim();
      const gradeLevel   = String(fd.get('grade_level') ?? '').trim();
      const displayName  = String(fd.get('display_name') ?? '').trim();
      const annualCents  = dollarsToCents(String(fd.get('annual_tuition_dollars') ?? ''));
      const position     = Math.max(0, parseInt(String(fd.get('position') ?? '0'), 10) || 0);

      if (!academicYear || !/^\d{4}-\d{2}$/.test(academicYear)) {
        return bounce(request, returnTo, { err: 'Academic year is required in format YYYY-YY (e.g. 2026-27).' });
      }
      if (!program)     return bounce(request, returnTo, { err: 'Program is required (e.g. "YC — 5 Days, Full Day").' });
      if (!gradeLevel)  return bounce(request, returnTo, { err: 'Grade level is required (e.g. "Young Community", "Primary", "Kindergarten").' });
      if (!displayName) return bounce(request, returnTo, { err: 'Display name is required.' });
      if (annualCents <= 0) return bounce(request, returnTo, { err: 'Annual tuition must be greater than $0.' });

      // Optional add-ons defined inline on the create form.
      const addons = parseAddons(fd);

      // The table has a UNIQUE constraint on (school_id, academic_year,
      // program, grade_level). Catch that as a friendly error.
      try {
        await query(
          `INSERT INTO tuition_grids
             (school_id, academic_year, program, grade_level, display_name,
              annual_tuition_cents, addons, is_active, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, $8)`,
          [session.school_id, academicYear, program, gradeLevel, displayName, annualCents,
           JSON.stringify(addons), position],
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('tuition_grids') && msg.includes('unique')) {
          return bounce(request, returnTo, {
            err: `A grid with this Program + Grade Level already exists for ${academicYear}. Pick a different program/grade combo.`,
          });
        }
        throw e;
      }
      const addonNote = addons.length ? ` with ${addons.length} add-on${addons.length === 1 ? '' : 's'}` : '';
      return bounce(request, returnTo, {
        msg: `Created grid "${displayName}" at $${(annualCents / 100).toLocaleString()} annual${addonNote}.`,
      });
    }

    if (op === 'update') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      const displayName = String(fd.get('display_name') ?? '').trim();
      const annualCents = dollarsToCents(String(fd.get('annual_tuition_dollars') ?? ''));
      const position    = Math.max(0, parseInt(String(fd.get('position') ?? '0'), 10) || 0);
      if (!displayName) return bounce(request, returnTo, { err: 'Display name is required.' });
      if (annualCents <= 0) return bounce(request, returnTo, { err: 'Annual tuition must be greater than $0.' });

      await query(
        `UPDATE tuition_grids
            SET display_name = $1, annual_tuition_cents = $2, position = $3, updated_at = now()
          WHERE id = $4 AND school_id = $5`,
        [displayName, annualCents, position, id, session.school_id],
      );
      return bounce(request, returnTo, { msg: `Updated grid "${displayName}".` });
    }

    if (op === 'deactivate') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      // Soft-delete to preserve the FK from family_tuition_enrollments.
      await query(
        `UPDATE tuition_grids SET is_active = false, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, session.school_id],
      );
      return bounce(request, returnTo, { msg: 'Grid deactivated. Existing enrollments still reference it; new enrollments can\'t pick it.' });
    }

    if (op === 'reactivate') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      await query(
        `UPDATE tuition_grids SET is_active = true, updated_at = now()
          WHERE id = $1 AND school_id = $2`,
        [id, session.school_id],
      );
      return bounce(request, returnTo, { msg: 'Grid reactivated.' });
    }

    if (op === 'set_addons') {
      const id = String(fd.get('id') ?? '').trim();
      if (!id) return bounce(request, returnTo, { err: 'Missing grid id.' });
      const addons = parseAddons(fd);
      // Replace the whole addons array. Existing enrollments are unaffected —
      // they captured an addon snapshot at creation time. Only NEW enrollments
      // pick up the revised catalog.
      const { rowCount } = await query(
        `UPDATE tuition_grids SET addons = $1::jsonb, updated_at = now()
          WHERE id = $2 AND school_id = $3`,
        [JSON.stringify(addons), id, session.school_id],
      );
      if (!rowCount) return bounce(request, returnTo, { err: 'Grid not found.' });
      return bounce(request, returnTo, {
        msg: addons.length
          ? `Saved ${addons.length} add-on${addons.length === 1 ? '' : 's'}.`
          : 'Cleared all add-ons for this grid.',
      });
    }

    return bounce(request, returnTo, { err: `Unknown op: ${op}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return bounce(request, returnTo, { err: msg });
  }
}
