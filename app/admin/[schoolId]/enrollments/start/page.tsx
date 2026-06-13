// /admin/[schoolId]/enrollments/start — set up a family's tuition for
// the year (operator console mirror of the embedded /school screen).
// Pick an existing family + student + grade (tuition from the rate
// card), optionally pre-select a payment frequency.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import {
  EnrollmentSetupForm,
  type FamilyOpt, type StudentOpt, type GridOpt, type PlanOpt,
} from './EnrollmentSetupForm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

const CURRENT_YEAR = '2026-27';

export default async function StartEnrollmentAdmin({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  const [{ rows: families }, { rows: students }, { rows: grids }, { rows: plans }, { rows: cfg }] =
    await Promise.all([
      query<FamilyOpt>(
        `SELECT f.id,
                COALESCE(NULLIF(f.display_name, ''),
                         CONCAT_WS(' ', p.first_name, p.last_name),
                         '(unnamed)') AS label
           FROM families f
           LEFT JOIN LATERAL (
             SELECT first_name, last_name FROM parents
             WHERE family_id = f.id AND is_primary = true LIMIT 1
           ) p ON true
          WHERE f.school_id = $1 AND f.status = 'active'
          ORDER BY label LIMIT 2000`,
        [schoolId],
      ),
      query<StudentOpt>(
        `SELECT id, family_id,
                CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name,
                metadata->>'program_name' AS program_name
           FROM students
          WHERE school_id = $1 AND status = 'active'
          ORDER BY first_name, last_name LIMIT 5000`,
        [schoolId],
      ),
      query<GridOpt>(
        `SELECT id, grade_level, display_name, annual_tuition_cents,
                COALESCE(addons, '[]'::jsonb) AS addons
           FROM tuition_grids
          WHERE school_id = $1 AND is_active = true AND academic_year = $2
          ORDER BY position, display_name`,
        [schoolId, CURRENT_YEAR],
      ),
      query<PlanOpt>(
        `SELECT id, display_name, installment_count, discount_basis_points
           FROM payment_plans
          WHERE school_id = $1 AND is_active = true
          ORDER BY position, installment_count`,
        [schoolId],
      ),
      query<{ billing_active: boolean }>(
        `SELECT COALESCE(billing_active, false) AS billing_active
           FROM school_payment_config WHERE school_id = $1`,
        [schoolId],
      ),
    ]);

  const studentsByFamily: Record<string, StudentOpt[]> = {};
  for (const s of students) (studentsByFamily[s.family_id] ??= []).push(s);

  const returnTo = `/admin/${schoolId}/payments`;

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-2xl space-y-4">
        <Link href={returnTo} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> Payments
        </Link>

        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">Set up a family&rsquo;s tuition</h1>
          <p className="text-xs text-zinc-500 mt-1">{school.name}</p>
        </div>

        {sp.msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div>
        ) : null}

        <EnrollmentSetupForm
          schoolId={schoolId}
          academicYear={CURRENT_YEAR}
          returnTo={returnTo}
          billingActive={!!cfg[0]?.billing_active}
          families={families}
          studentsByFamily={studentsByFamily}
          grids={grids}
          plans={plans}
        />
      </div>
    </main>
  );
}
