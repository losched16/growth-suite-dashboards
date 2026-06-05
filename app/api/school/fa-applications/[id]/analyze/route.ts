// POST /api/school/fa-applications/[id]/analyze
//
// Run Claude analysis for the application and cache the result on
// fa_applications.ai_analysis. School-session-authed. If an analysis
// already exists, it's overwritten (operator clicked Regenerate).
//
// Returns the analysis JSON so the client can render immediately
// without waiting for a separate fetch.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getFinancialAidSettings } from '@/lib/financial-aid/settings';
import { analyzeApplication, type FaAnalysisInput } from '@/lib/ai/fa-analysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Sonnet can take ~10-20s on a long application. Bump from the
// default 10s so we don't time out.
export const maxDuration = 60;

type Params = Promise<{ id: string }>;

interface AppRow {
  id: string;
  school_id: string;
  family_id: string;
  academic_year: string;
  household_size: number | null;
  responses: Record<string, unknown>;
  family_display_name: string;
  school_name: string;
}

interface StudentRow {
  student_id: string;
  first_name: string;
  last_name: string;
  current_tuition: string | null;
  requested_aid: string | null;
}

interface FileRow {
  document_type: string | null;
  display_name: string;
  size_bytes: number;
}

export async function POST(req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;

  // Auth: accept EITHER a school admin session cookie OR an internal
  // shared-secret header. The internal path is how the parent portal
  // fires off analysis right after a parent hits Submit — we want the
  // committee to never see an unanalyzed app on first queue load.
  let schoolIdFilter: string | null = null;
  const internalSecret = process.env.INTERNAL_FA_SECRET;
  const authHeader = req.headers.get('authorization');
  if (internalSecret && authHeader === `Bearer ${internalSecret}`) {
    // Internal — trust the caller, scope by the row's own school_id.
    schoolIdFilter = null;
  } else {
    const ck = await cookies();
    const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
    if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    schoolIdFilter = session.school_id;
  }

  // Load the application + scope-check
  const { rows: apps } = await query<AppRow>(
    `SELECT a.id, a.school_id, a.family_id, a.academic_year,
            a.household_size, a.responses,
            f.display_name AS family_display_name,
            sc.name AS school_name
       FROM fa_applications a
       JOIN families f ON f.id = a.family_id
       JOIN schools sc ON sc.id = a.school_id
      WHERE a.id = $1
        AND ($2::uuid IS NULL OR a.school_id = $2)`,
    [id, schoolIdFilter],
  );
  if (apps.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const app = apps[0];

  const { rows: students } = await query<StudentRow>(
    `SELECT cs.student_id, s.first_name, s.last_name,
            cs.current_tuition::text, cs.requested_aid::text
       FROM fa_application_students cs
       JOIN students s ON s.id = cs.student_id
      WHERE cs.application_id = $1`,
    [id],
  );

  const { rows: files } = await query<FileRow>(
    `SELECT document_type, display_name, size_bytes
       FROM fa_application_files WHERE application_id = $1`,
    [id],
  );

  const settings = await getFinancialAidSettings(app.school_id);

  // Pull marital_status out of the new (10-section) shape OR the
  // old (7-section) shape so older drafts don't break.
  const family = (app.responses?.family as Record<string, unknown>) ?? {};
  const household = (app.responses?.household as Record<string, unknown>) ?? {};
  const maritalStatus = (family.marital_status as string)
    ?? (household.marital_status as string)
    ?? null;

  const input: FaAnalysisInput = {
    family_display_name: app.family_display_name,
    household_size: app.household_size,
    marital_status: maritalStatus,
    academic_year: app.academic_year,
    school_name: app.school_name,
    required_document_types: settings.required_document_types,
    max_award_pct_of_tuition: settings.max_award_pct_of_tuition,
    min_family_contribution_pct: settings.min_family_contribution_pct,
    max_award_per_student_cents: settings.max_award_per_student_cents,
    policy_notes: settings.policy_notes,
    regional_col_multiplier: settings.regional_col_multiplier,
    regional_col_label: settings.regional_col_label,
    students: students.map((s) => ({
      student_id: s.student_id,
      first_name: s.first_name,
      last_name: s.last_name,
      current_tuition_cents: Math.round(Number(s.current_tuition ?? 0) * 100),
      requested_aid_cents: Math.round(Number(s.requested_aid ?? 0) * 100),
    })),
    responses: app.responses ?? {},
    documents: files.map((f) => ({
      document_type: f.document_type,
      filename: f.display_name,
      size_bytes: f.size_bytes,
    })),
  };

  let result;
  try {
    result = await analyzeApplication(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[fa/analyze] failed:', msg);
    return NextResponse.json({
      error: 'analysis_failed',
      detail: msg,
    }, { status: 502 });
  }

  await query(
    `UPDATE fa_applications
        SET ai_analysis = $1::jsonb,
            ai_analyzed_at = now(),
            ai_analysis_model = $2
      WHERE id = $3`,
    [JSON.stringify(result.result), result.model, id],
  );

  return NextResponse.json({
    ok: true,
    analysis: result.result,
    model: result.model,
    analyzed_at: new Date().toISOString(),
  });
}
