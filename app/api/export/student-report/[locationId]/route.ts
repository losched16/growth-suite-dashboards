// GET /api/export/student-report/{locationId}
//   ?form=<id>[&form=<id>…] | ?forms=all
//   [&match=<pattern>]   only questions whose label/key matches (case-insensitive)
//   [&flagged=1]         only students with a "yes"/non-empty answer in those questions
//   [&classroom=<name>]  one classroom
//   [&scope=all]         every active student, not just enrolled
//   [&embed_token=…]
//
// Whole-school, one row per student (see lib/forms/student-report.ts).
// Opens straight in Excel (UTF-8 BOM).

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authorizeExport, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp } from '@/lib/exports/csv';
import { buildStudentReport, parseMatch, type ReportRow } from '@/lib/forms/student-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const sp = request.nextUrl.searchParams;
  const formIds = sp.get('forms') === 'all' ? 'all' as const : sp.getAll('form').filter(Boolean);
  if (formIds !== 'all' && formIds.length === 0) {
    return NextResponse.json({ error: 'choose at least one form (form=<id> or forms=all)' }, { status: 400 });
  }
  const match = parseMatch(sp.get('match'));
  if (match === 'invalid') return NextResponse.json({ error: 'invalid match pattern' }, { status: 400 });

  const report = await buildStudentReport({
    schoolId: school.id,
    formIds,
    match,
    flaggedOnly: sp.get('flagged') === '1',
    classroom: sp.get('classroom') || null,
    scope: sp.get('scope') === 'all' ? 'all' : 'enrolled',
  });

  const multi = report.forms.length > 1;
  const columns = [
    { key: 'student', label: 'Student' },
    { key: 'lastName', label: 'Last name' },
    { key: 'firstName', label: 'First name' },
    { key: 'classroom', label: 'Classroom' },
    { key: 'family', label: 'Family' },
    { key: 'parentName', label: 'Parent' },
    { key: 'parentEmail', label: 'Parent email' },
    { key: 'parentPhone', label: 'Parent phone' },
    ...report.forms.map((f) => ({
      key: `sub:${f.id}`,
      label: multi ? `${f.name}: submitted` : 'Submitted',
      value: (r: ReportRow) => r.submittedOn[f.id] ?? 'Not submitted',
    })),
    ...report.forms.map((f) => ({
      key: `src:${f.id}`,
      label: multi ? `${f.name}: answered on` : 'Answered on',
      value: (r: ReportRow) => r.source[f.id] ?? '',
    })),
    ...report.columns.map((c) => ({ key: c.id, label: c.label, value: (r: ReportRow) => r.values[c.id] ?? '' })),
  ];

  const name = report.forms.length === 1 ? report.forms[0].slug : sp.get('flagged') === '1' ? 'flagged-students' : 'student-report';
  const cls = sp.get('classroom') ? `-${sp.get('classroom')!.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return csvResponse(`${name}${cls}-by-student-${dateStamp()}.csv`, toCsv(report.rows, columns));
}
