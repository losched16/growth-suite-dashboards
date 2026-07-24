// /school/[locationId]/enrollments/start — set up a family's tuition for
// the year. Pick an existing family + student, pick the grade (tuition
// comes from the rate card), optionally pre-select a payment frequency.
//
// Frequency chosen → invoices generate + parent sees the plan locked.
// Frequency left blank → parent picks it in their enrollment agreement.
//
// Enrollment AGREEMENT forms live in the parent portal — this screen is
// purely the billing setup. Posts to the shared payments/enrollments API
// with a hidden return_to so the operator stays in the embedded iframe.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolSettings } from '@/lib/school-settings';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadAddonCatalog } from '@/lib/billing/addon-catalog';
import { HelpCallout } from '@/components/HelpCallout';
import {
  EnrollmentSetupForm,
  type FamilyOpt, type StudentOpt, type GridOpt, type PlanOpt,
} from '@/app/admin/[schoolId]/enrollments/start/EnrollmentSetupForm';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string; family?: string }>;


export default async function StartEnrollmentScoped({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const schoolId = school.id;
  const CURRENT_YEAR = (await loadSchoolSettings(schoolId)).academic_year;

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

  const addonCatalog = await loadAddonCatalog(schoolId);

  const studentsByFamily: Record<string, StudentOpt[]> = {};
  for (const s of students) (studentsByFamily[s.family_id] ??= []).push(s);

  const returnTo = `/school/${locationId}/payments?tab=plans`;

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-2xl space-y-4">
        <Link href={returnTo} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back to Tuition Plans
        </Link>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Set up a family&rsquo;s tuition</h1>
          <p className="text-xs text-slate-500 mt-1">
            Pick the family + student and their grade — tuition is calculated from your rate card.
            Optionally lock in a payment frequency, or let the parent choose theirs.
          </p>
        </div>

        <HelpCallout
          title="How enrollment works"
          defaultOpen={false}
          steps={[
            <>Pick the <strong>family</strong> and <strong>student</strong> (they must already be on your roster — add new families via your contact sync first).</>,
            <>Pick the <strong>grade / program</strong>. The annual tuition fills in automatically from your <strong>Grids</strong> rate card.</>,
            <>Optionally pre-select a <strong>payment frequency</strong>. If you do, the parent sees it locked in. If not, the parent picks Annual / Semi-Annual / Monthly in their enrollment agreement.</>,
            <>Enrollment <em>agreement</em> + medical / consent forms live in the parent portal — this screen is only the tuition setup.</>,
          ]}
        />

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
          addonCatalog={addonCatalog}
          defaultFamilyId={typeof sp.family === 'string' ? sp.family : undefined}
        />
      </div>
    </main>
  );
}
