// POST /api/admin/schools/[schoolId]/facts-import/[importId]/commit
//
// Reads the preview row_log from school_facts_imports and writes
// family_tuition_enrollments for every 'matched' row. Idempotent:
// existing enrollment for (school, family, student, academic_year) is
// UPDATED in place; new ones are INSERTed.
//
// Schools always set the canonical amount from FACTS via this path,
// then later parents pick a plan in /tuition.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Params = Promise<{ schoolId: string; importId: string }>;

interface RowLogEntry {
  rowNumber: number;
  status: string;
  student_id?: string;
  family_id?: string;
  annual_tuition_cents?: number;
  plan_name?: string;
  matched_plan_id?: string | null;
}

interface ImportRow {
  academic_year: string;
  row_log: RowLogEntry[];
  status: string;
  initiated_by: string | null;
}

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { schoolId, importId } = await params;

  // Load preview
  const { rows: imports } = await query<ImportRow>(
    `SELECT academic_year, row_log, status, initiated_by
       FROM school_facts_imports
      WHERE id = $1 AND school_id = $2`,
    [importId, schoolId],
  );
  if (imports.length === 0) {
    return NextResponse.json({ error: 'import_not_found' }, { status: 404 });
  }
  const imp = imports[0];
  if (imp.status !== 'previewing') {
    return NextResponse.json(
      { error: 'wrong_status', detail: `Import status is "${imp.status}", expected "previewing".` },
      { status: 409 },
    );
  }

  let inserted = 0, updated = 0, errored = 0;
  const errorDetails: Array<{ rowNumber: number; reason: string }> = [];

  for (const row of imp.row_log) {
    if (row.status !== 'matched') continue;
    if (!row.student_id || !row.family_id || row.annual_tuition_cents == null) {
      errored++;
      errorDetails.push({ rowNumber: row.rowNumber, reason: 'preview row missing required fields' });
      continue;
    }

    try {
      // UPSERT on (school_id, family_id, student_id, academic_year).
      // The schema has these as separate columns — let me check it has
      // a unique constraint, else fall back to find-then-update.
      const existing = await query<{ id: string }>(
        `SELECT id FROM family_tuition_enrollments
          WHERE school_id = $1 AND family_id = $2 AND student_id = $3 AND academic_year = $4`,
        [schoolId, row.family_id, row.student_id, imp.academic_year],
      );

      if (existing.rows.length > 0) {
        // Update — keep any plan they may have picked, but refresh the
        // tuition amount. If a new plan name is on this row and the
        // parent hasn't picked yet, set it.
        await query(
          `UPDATE family_tuition_enrollments
              SET annual_tuition_cents = $1,
                  total_annual_cents   = $1,  -- addons get re-applied when parent picks
                  payment_plan_id      = COALESCE(payment_plan_id, $2),
                  status               = CASE WHEN status = 'committed' THEN 'committed' ELSE 'draft' END,
                  internal_note        = COALESCE(internal_note, '') || E'\\n[' || now()::date::text || '] Updated from FACTS import',
                  updated_at           = now()
            WHERE id = $3`,
          [row.annual_tuition_cents, row.matched_plan_id ?? null, existing.rows[0].id],
        );
        updated++;
      } else {
        await query(
          `INSERT INTO family_tuition_enrollments
             (school_id, family_id, student_id, academic_year,
              annual_tuition_cents, total_annual_cents,
              payment_plan_id, plan_discount_basis_points,
              addons, installment_count, schedule, status,
              created_by_email, internal_note)
           VALUES ($1, $2, $3, $4, $5, $5, $6, 0, '[]'::jsonb, 0, NULL,
                   'draft', $7, $8)`,
          [
            schoolId, row.family_id, row.student_id, imp.academic_year,
            row.annual_tuition_cents,
            row.matched_plan_id ?? null,
            imp.initiated_by ?? 'operator',
            `Imported from FACTS on ${new Date().toISOString().slice(0, 10)}`,
          ],
        );
        inserted++;
      }
    } catch (e) {
      errored++;
      errorDetails.push({
        rowNumber: row.rowNumber,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Update import record with final counts + status
  await query(
    `UPDATE school_facts_imports
        SET rows_inserted = $1, rows_updated = $2, rows_errored = $3,
            status = 'committed', updated_at = now()
      WHERE id = $4`,
    [inserted, updated, errored, importId],
  );

  return NextResponse.json({
    ok: true,
    inserted, updated, errored,
    error_details: errorDetails.slice(0, 50),
  });
}
