// CSV export — DocumentTracker. One row per family with form-completion
// columns. Per-student forms show "X of N" (count of students who
// completed) and a separate per-student detail CSV is offered via
// `?type=per_student`.

import type { NextRequest } from 'next/server';
import {
  authorizeExport,
  unauthorizedCsvResponse,
  csvResponse,
  toCsv,
  dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { fetcher as docFetcher, type FamilyRow } from '@/lib/widgets/components/DocumentTracker/fetcher';
import { documentTrackerDefaults } from '@/lib/widgets/components/DocumentTracker/config';

type Params = Promise<{ locationId: string }>;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const data = await docFetcher(
    { schoolId: school.id, schoolName: school.name, locationId: school.ghl_location_id },
    documentTrackerDefaults,
  );

  const type = request.nextUrl.searchParams.get('type') ?? 'family';

  if (type === 'per_student') {
    // Flatten: one row per student per form, with applies/complete/value
    interface FlatRow {
      family: string;
      parent_email: string;
      student: string;
      form: string;
      applies: boolean;
      complete: boolean;
      completed_value: string;
    }
    const flat: FlatRow[] = [];
    for (const row of data.rows) {
      for (const form of data.forms) {
        const cells = row.cells[form.id] ?? [];
        for (const c of cells) {
          flat.push({
            family: row.family_display_name,
            parent_email: row.primary_parent_email ?? '',
            student: c.display_name,
            form: form.display_name,
            applies: c.applies,
            complete: c.complete,
            completed_value: c.completed_value ?? '',
          });
        }
      }
    }
    return csvResponse(
      `${school.name}-forms-per-student-${dateStamp()}.csv`,
      toCsv(flat, [
        { key: 'family',          label: 'Family' },
        { key: 'parent_email',    label: 'Parent email' },
        { key: 'student',         label: 'Student' },
        { key: 'form',            label: 'Form' },
        { key: 'applies',         label: 'Applies' },
        { key: 'complete',        label: 'Complete' },
        { key: 'completed_value', label: 'Completion value' },
      ]),
    );
  }

  // Default: one row per family with summary + per-form cell summary
  const cols: CsvColumn<FamilyRow>[] = [
    { key: 'family',  label: 'Family',                      value: (r) => r.family_display_name },
    { key: 'parent',  label: 'Primary parent',              value: (r) => r.primary_parent_name },
    { key: 'email',   label: 'Email',                       value: (r) => r.primary_parent_email ?? '' },
    { key: 'students', label: 'Enrolled students',          value: (r) => r.enrolled_students.map((s) => s.display_name).join('; ') },
    { key: 'count',   label: '# students',                  value: (r) => r.enrolled_student_count },
    { key: 'pct',     label: 'Completion %',                value: (r) => r.pct },
    { key: 'status',  label: 'Status',                      value: (r) => r.status.replace(/_/g, ' ') },
    { key: 'complete', label: 'Forms complete',             value: (r) => r.complete_count },
    { key: 'applicable', label: 'Forms applicable',         value: (r) => r.applicable_count },
  ];

  // Add one column per form with "X of N" complete-among-applicable
  for (const form of data.forms) {
    cols.push({
      key: `form_${form.id}`,
      label: form.display_name,
      value: (r) => {
        const cells = r.cells[form.id] ?? [];
        const applicable = cells.filter((c) => c.applies);
        const done = applicable.filter((c) => c.complete);
        if (applicable.length === 0) return 'n/a';
        return `${done.length} of ${applicable.length}`;
      },
    });
  }

  return csvResponse(
    `${school.name}-document-tracker-${dateStamp()}.csv`,
    toCsv(data.rows, cols),
  );
}
