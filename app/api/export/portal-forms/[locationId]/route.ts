// CSV export — per-student portal form status.
//
// GET /api/export/portal-forms/{locationId}?form=<id|omit>&grade=<opt>&status=missing|all
//
// One row per (form, applicable student) — or per (form, family) for
// family-level forms. status=missing keeps only the un-submitted rows:
// the office's "who still owes us the MYHS tech agreement, with parent
// emails, sortable by grade" list. Non-applicable students (wrong
// grade/program for the form's targeting) are excluded entirely.

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExport, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher } from '@/lib/widgets/components/PortalFormsTracker/fetcher';
import type { PortalFormsTrackerConfig } from '@/lib/widgets/components/PortalFormsTracker/config';

type Params = Promise<{ locationId: string }>;

interface Row {
  form: string;
  family: string;
  parent: string;
  email: string;
  phone: string;
  student: string;
  grade: string;
  status: 'submitted' | 'missing';
  submitted_at: string;
}

const COLUMNS: CsvColumn<Row>[] = [
  { key: 'form', label: 'Form' },
  { key: 'family', label: 'Family' },
  { key: 'parent', label: 'Parent (primary)' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'student', label: 'Student' },
  { key: 'grade', label: 'Grade' },
  { key: 'status', label: 'Status' },
  { key: 'submitted_at', label: 'Submitted' },
];

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const sp = request.nextUrl.searchParams;
  const formFilter = sp.get('form') ?? '';
  const grade = sp.get('grade') ?? '';
  const onlyMissing = (sp.get('status') ?? 'missing') !== 'all';

  // Honor the school's saved tracker config (categories, external items,
  // include_pending, tag scoping) so the CSV matches the on-screen grid.
  const { rows: dashRows } = await query<{ layout: Array<{ widget_id: string; config: Partial<PortalFormsTrackerConfig> }> }>(
    `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'portal-forms'`,
    [school.id],
  );
  // Use the saved config AS-IS — the page's WidgetRenderer passes
  // instance.config raw (no defaults merge), and the fetcher guards
  // every missing key. Merging portalFormsTrackerDefaults here silently
  // applied its enrolled_tag filter and emptied the export.
  const saved = dashRows[0]?.layout?.find((w) => w.widget_id === 'portal_forms_tracker')?.config ?? {};
  const config = saved as PortalFormsTrackerConfig;

  const data = await fetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    config,
    grade ? { grade } : {},
  );

  // ?debug=counts — authed JSON introspection when the CSV looks off.
  if (sp.get('debug') === 'counts') {
    return new Response(JSON.stringify({
      forms: data.forms.length,
      form_names: data.forms.map((f) => f.display_name),
      rows: data.rows.length,
      grade_levels: data.grade_levels,
      stats: data.stats,
      sample_cells: data.rows[0] ? Object.fromEntries(Object.entries(data.rows[0].cells).slice(0, 2)) : null,
    }, null, 1), { headers: { 'Content-Type': 'application/json' } });
  }

  const forms = formFilter ? data.forms.filter((f) => f.id === formFilter) : data.forms;
  const out: Row[] = [];
  for (const form of forms) {
    for (const fam of data.rows) {
      const chips = fam.cells[form.id] ?? [];
      for (const chip of chips) {
        if (!chip.applies) continue;
        if (onlyMissing && chip.complete) continue;
        const stu = fam.enrolled_students.find((s) => s.student_id === chip.student_id);
        out.push({
          form: form.display_name,
          family: fam.family_display_name,
          parent: fam.primary_parent_name,
          email: fam.primary_parent_email ?? '',
          phone: fam.primary_parent_phone ?? '',
          student: chip.slot === 0 ? '(family-level)' : chip.display_name,
          grade: stu?.grade_level ?? '',
          status: chip.complete ? 'submitted' : 'missing',
          submitted_at: chip.submitted_at ? chip.submitted_at.slice(0, 10) : '',
        });
      }
    }
  }
  // Pre-sort: grade, then family — the office reads this grade-by-grade.
  out.sort((a, b) => a.grade.localeCompare(b.grade) || a.family.localeCompare(b.family) || a.form.localeCompare(b.form));

  const formLabel = formFilter ? (forms[0]?.display_name ?? 'form') : 'all forms';
  const name = `form status ${formLabel}${grade ? ` grade ${grade}` : ''}${onlyMissing ? ' missing' : ''} ${dateStamp()}.csv`;
  return csvResponse(name, toCsv(out, COLUMNS));
}
