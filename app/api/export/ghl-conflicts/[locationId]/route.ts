// CSV export — co-parent contact conflicts. Lists every active student
// whose linked Growth Suite contacts hold DIFFERENT values for the same
// field (e.g. one parent's record says "Enrolled", the other "Accepted"),
// with both parents' contact links so the office can open and reconcile
// them. Populated by the GHL→dashboard sync (metadata.ghl_conflicts).
//
// GET /api/export/ghl-conflicts/{locationId}

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExport, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';
import { ghlContactUrl } from '@/lib/ghl/contact-url';

type Params = Promise<{ locationId: string }>;

interface Row {
  student: string;
  family: string;
  field: string;
  values: string;
  p1: string; p1_id: string | null;
  p2: string; p2_id: string | null;
}

// snake_case field base → friendly label (falls back to a title-cased key).
const LABELS: Record<string, string> = {
  enrollment_status: 'Enrollment Status',
  program: 'Program', program_name: 'Program',
  homeroom: 'Homeroom', lead_teacher: 'Lead Teacher',
  payment_plan: 'Payment Plan', program_tuition: 'Tuition',
  organic_lunch: 'Organic Lunch', extended_day: 'Extended Day',
  physical_custody: 'Physical Custody', legal_authority: 'Legal Authority',
};
const human = (k: string) => LABELS[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const { rows: students } = await query<{
    student: string; family: string; conflicts: Record<string, string[]>;
    p1: string | null; p1_id: string | null; p2: string | null; p2_id: string | null;
  }>(
    `SELECT CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student,
            COALESCE(NULLIF(f.display_name, ''), '') AS family,
            s.metadata->'ghl_conflicts' AS conflicts,
            CONCAT_WS(' ', p1.first_name, p1.last_name) AS p1, p1.ghl_contact_id AS p1_id,
            CONCAT_WS(' ', p2.first_name, p2.last_name) AS p2, p2.ghl_contact_id AS p2_id
       FROM students s
       JOIN families f ON f.id = s.family_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, ghl_contact_id FROM parents
          WHERE family_id = f.id AND status = 'active'
          ORDER BY is_primary DESC, created_at ASC LIMIT 1
       ) p1 ON true
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, ghl_contact_id FROM parents
          WHERE family_id = f.id AND status = 'active'
          ORDER BY is_primary DESC, created_at ASC OFFSET 1 LIMIT 1
       ) p2 ON true
      WHERE s.school_id = $1 AND s.status = 'active'
        AND s.metadata ? 'ghl_conflicts'
      ORDER BY s.last_name, s.first_name`,
    [school.id],
  );

  const rows: Row[] = [];
  for (const s of students) {
    for (const [field, vals] of Object.entries(s.conflicts ?? {})) {
      rows.push({
        student: s.student, family: s.family,
        field: human(field), values: (vals as string[]).join('  |  '),
        p1: s.p1 ?? '', p1_id: s.p1_id, p2: s.p2 ?? '', p2_id: s.p2_id,
      });
    }
  }

  const cols: CsvColumn<Row>[] = [
    { key: 'student', label: 'Student' },
    { key: 'family', label: 'Family' },
    { key: 'field', label: 'Field in conflict' },
    { key: 'values', label: 'Conflicting values' },
    { key: 'p1', label: 'Parent 1' },
    { key: 'p1_link', label: 'Parent 1 contact link', value: (r) => (r.p1_id ? ghlContactUrl(locationId, r.p1_id) : '') },
    { key: 'p2', label: 'Parent 2' },
    { key: 'p2_link', label: 'Parent 2 contact link', value: (r) => (r.p2_id ? ghlContactUrl(locationId, r.p2_id) : '') },
  ];

  return csvResponse(`contact-conflicts-${dateStamp()}.csv`, toCsv(rows, cols));
}
