// POST /api/admin/schools/[schoolId]/facts-import/preview
//
// Parses + maps + matches a FACTS CSV without writing enrollments.
// Creates a school_facts_imports row in 'previewing' status so the
// commit endpoint can find the parsed result. Returns per-row outcomes
// for the operator to review before committing.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import {
  parseCsv, mapRows, loadStudentLookup, matchRowToStudent, matchPlanName,
} from '@/lib/billing/facts-import';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ schoolId: string }>;

interface Body {
  csv: string;
  academic_year: string;
  field_mapping: Record<string, string>;
  plan_name_aliases: Record<string, string>;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { schoolId } = await params;

  let body: Body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.csv || !body.academic_year) {
    return NextResponse.json({ error: 'missing_required_fields' }, { status: 400 });
  }

  // 1. Parse CSV
  const { headers, rows } = parseCsv(body.csv);
  if (headers.length === 0 || rows.length === 0) {
    return NextResponse.json({ error: 'empty_csv', detail: 'No header row or no data rows.' }, { status: 400 });
  }

  // 2. Map to standard fields
  const mapped = mapRows(rows, body.field_mapping);

  // 3. Load student lookup (one query, in-memory match)
  const candidates = await loadStudentLookup(schoolId);

  // 4. Load this school's payment plans for plan-name matching
  const { rows: plans } = await query<{ id: string; slug: string; display_name: string }>(
    `SELECT id, slug, display_name FROM payment_plans WHERE school_id = $1 AND is_active = true`,
    [schoolId],
  );

  // 5. Walk rows, build per-row outcomes
  const distinctPlanValues = new Set<string>();
  const outcomes: Array<{
    rowNumber: number; status: string;
    student_name?: string; student_id?: string; family_id?: string;
    annual_tuition_cents?: number; plan_name?: string;
    matched_plan_id?: string | null; reason?: string;
  }> = [];

  let matched = 0, ambiguous = 0, noStudent = 0, noData = 0;

  for (const row of mapped) {
    if (row.plan_name) distinctPlanValues.add(row.plan_name);

    // Sanity — at minimum we need a name AND a tuition number
    if (!row.student_first || !row.student_last || row.annual_tuition_cents == null) {
      noData++;
      outcomes.push({
        rowNumber: row.rowNumber, status: 'no_data',
        reason: 'missing required fields (student name + annual tuition)',
        annual_tuition_cents: row.annual_tuition_cents,
        plan_name: row.plan_name,
      });
      continue;
    }

    const match = matchRowToStudent(row, candidates);
    if (!match.student_id) {
      if (match.reason?.startsWith('ambiguous')) {
        ambiguous++;
        outcomes.push({
          rowNumber: row.rowNumber, status: 'ambiguous',
          student_name: `${row.student_first} ${row.student_last}`,
          annual_tuition_cents: row.annual_tuition_cents,
          plan_name: row.plan_name, reason: match.reason,
        });
      } else {
        noStudent++;
        outcomes.push({
          rowNumber: row.rowNumber, status: 'no_student',
          student_name: `${row.student_first} ${row.student_last}`,
          annual_tuition_cents: row.annual_tuition_cents,
          plan_name: row.plan_name, reason: match.reason,
        });
      }
      continue;
    }

    matched++;
    const matchedPlanId = matchPlanName(row.plan_name, plans, body.plan_name_aliases);
    outcomes.push({
      rowNumber: row.rowNumber, status: 'matched',
      student_name: `${row.student_first} ${row.student_last}`,
      student_id: match.student_id,
      family_id: match.family_id,
      annual_tuition_cents: row.annual_tuition_cents,
      plan_name: row.plan_name,
      matched_plan_id: matchedPlanId,
    });
  }

  // 6. Persist as a previewing import — commit endpoint will read it
  const { rows: ins } = await query<{ id: string }>(
    `INSERT INTO school_facts_imports
       (school_id, academic_year, initiated_by, raw_csv, headers,
        total_rows, rows_matched, rows_inserted, rows_updated,
        rows_skipped, rows_errored, row_log, field_mapping_used, status)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, 0, 0, $8, 0, $9::jsonb, $10::jsonb, 'previewing')
     RETURNING id`,
    [
      schoolId, body.academic_year, 'operator',
      body.csv.length > 50_000 ? body.csv.slice(0, 50_000) : body.csv,
      headers,
      mapped.length, matched,
      noStudent + ambiguous + noData,
      JSON.stringify(outcomes),
      JSON.stringify({
        field_mapping: body.field_mapping,
        plan_name_aliases: body.plan_name_aliases,
      }),
    ],
  );

  // Save mapping for next time (UPSERT)
  await query(
    `INSERT INTO school_facts_import_mappings (school_id, field_mapping, plan_name_aliases, academic_year, last_used_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, now())
     ON CONFLICT (school_id) DO UPDATE SET
       field_mapping = EXCLUDED.field_mapping,
       plan_name_aliases = EXCLUDED.plan_name_aliases,
       academic_year = EXCLUDED.academic_year,
       last_used_at = now(),
       updated_at = now()`,
    [
      schoolId,
      JSON.stringify(body.field_mapping),
      JSON.stringify(body.plan_name_aliases),
      body.academic_year,
    ],
  );

  return NextResponse.json({
    ok: true,
    import_id: ins[0].id,
    summary: { totalRows: mapped.length, matched, ambiguous, noStudent, noData },
    rows: outcomes,
    distinct_plan_values: [...distinctPlanValues].sort(),
  });
}
