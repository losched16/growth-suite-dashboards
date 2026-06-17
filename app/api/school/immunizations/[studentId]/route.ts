// POST /api/school/immunizations/[studentId]
//
// Staff dose-entry: replace a student's immunization profile, per-vaccine
// flags, and dose ledger in one transaction. School-session authed and
// scoped — the student must belong to the session's school.
//
// Body (JSON):
//   profile: { certificate_on_file, all_vaccine_exemption, in_process, in_process_note }
//   flags:   [{ vaccine_code, exemption, immunity_documented, not_required }]
//   doses:   [{ vaccine_code, dose_number, date_administered, status_override }]
//
// We delete+reinsert flags and doses (idempotent full-replace) so the
// client just sends the complete current state of the form.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query, withTransaction } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ studentId: string }>;

const VACCINE_CODES = new Set(['dtap', 'ipv', 'hib', 'hepb', 'mmr', 'var', 'pcv', 'tdap', 'mcv']);
const EXEMPTIONS = new Set(['none', 'medical', 'religious']);
const OVERRIDES = new Set(['not_applicable', 'skipped']);

interface Body {
  profile?: {
    certificate_on_file?: boolean;
    all_vaccine_exemption?: string;
    in_process?: boolean;
    in_process_note?: string | null;
  };
  flags?: Array<{ vaccine_code?: string; exemption?: string; immunity_documented?: boolean; not_required?: boolean }>;
  doses?: Array<{ vaccine_code?: string; dose_number?: number; date_administered?: string | null; status_override?: string | null }>;
}

function validDate(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : s;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { studentId } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Scope-check: student must belong to this school.
  const { rows: studentRows } = await query<{ id: string }>(
    `SELECT id FROM students WHERE id = $1 AND school_id = $2`,
    [studentId, session.school_id],
  );
  if (studentRows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: 'bad_body' }, { status: 400 });

  // ── sanitize profile ──
  const p = body.profile ?? {};
  const certificate_on_file = p.certificate_on_file === true;
  const all_vaccine_exemption = EXEMPTIONS.has(p.all_vaccine_exemption ?? '') ? p.all_vaccine_exemption! : 'none';
  const in_process = p.in_process === true;
  const in_process_note = typeof p.in_process_note === 'string' ? p.in_process_note.slice(0, 1000) || null : null;

  // ── sanitize flags (keep only non-default rows) ──
  const flags = (Array.isArray(body.flags) ? body.flags : [])
    .filter((f) => VACCINE_CODES.has(f.vaccine_code ?? ''))
    .map((f) => ({
      vaccine_code: f.vaccine_code!,
      exemption: EXEMPTIONS.has(f.exemption ?? '') ? f.exemption! : 'none',
      immunity_documented: f.immunity_documented === true,
      not_required: f.not_required === true,
    }))
    .filter((f) => f.exemption !== 'none' || f.immunity_documented || f.not_required);

  // ── sanitize doses ──
  const seen = new Set<string>();
  const doses = (Array.isArray(body.doses) ? body.doses : [])
    .filter((d) => VACCINE_CODES.has(d.vaccine_code ?? '')
      && Number.isInteger(d.dose_number) && (d.dose_number as number) >= 1 && (d.dose_number as number) <= 6)
    .map((d) => ({
      vaccine_code: d.vaccine_code!,
      dose_number: d.dose_number as number,
      date_administered: validDate(d.date_administered),
      status_override: OVERRIDES.has(d.status_override ?? '') ? d.status_override! : null,
    }))
    // a dose row is meaningful only if it has a date OR an override
    .filter((d) => d.date_administered || d.status_override)
    // de-dupe (student, vaccine, dose#) — last wins
    .filter((d) => {
      const key = `${d.vaccine_code}:${d.dose_number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const reviewer = session.user_email || 'staff';

  await withTransaction(async (q) => {
    await q(
      `INSERT INTO student_immunization_profile
         (school_id, student_id, certificate_on_file, all_vaccine_exemption, in_process, in_process_note, reviewed_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (school_id, student_id) DO UPDATE SET
         certificate_on_file = EXCLUDED.certificate_on_file,
         all_vaccine_exemption = EXCLUDED.all_vaccine_exemption,
         in_process = EXCLUDED.in_process,
         in_process_note = EXCLUDED.in_process_note,
         reviewed_by = EXCLUDED.reviewed_by,
         updated_at = now()`,
      [session.school_id, studentId, certificate_on_file, all_vaccine_exemption, in_process, in_process_note, reviewer],
    );

    await q(`DELETE FROM student_vaccine_flags WHERE student_id = $1 AND school_id = $2`, [studentId, session.school_id]);
    for (const f of flags) {
      await q(
        `INSERT INTO student_vaccine_flags (school_id, student_id, vaccine_code, exemption, immunity_documented, not_required, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())`,
        [session.school_id, studentId, f.vaccine_code, f.exemption, f.immunity_documented, f.not_required],
      );
    }

    await q(`DELETE FROM student_immunization_doses WHERE student_id = $1 AND school_id = $2`, [studentId, session.school_id]);
    for (const d of doses) {
      await q(
        `INSERT INTO student_immunization_doses (school_id, student_id, vaccine_code, dose_number, date_administered, status_override, source, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'office',$7, now())`,
        [session.school_id, studentId, d.vaccine_code, d.dose_number, d.date_administered, d.status_override, reviewer],
      );
    }
  });

  return NextResponse.json({ ok: true, doses: doses.length, flags: flags.length });
}
