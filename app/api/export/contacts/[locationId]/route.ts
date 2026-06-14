// CSV export — all contact info (2026-27). One row per active student
// with their family, both parents (name / email / phone / Growth Suite
// contact id), and address. Mirrors the parent-roster input file so the
// office can verify every contact landed correctly.
//
// GET /api/export/contacts/{locationId}

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExportPublic, unauthorizedCsvResponse, csvResponse, toCsv, dateStamp,
  type CsvColumn,
} from '@/lib/exports/csv';

type Params = Promise<{ locationId: string }>;

interface ContactRow {
  student: string;
  family: string;
  program: string | null;
  homeroom: string | null;
  unique_id: string | null;
  household_id: string | null;
  street: string | null; city: string | null; state: string | null; zip: string | null;
  p1_first: string | null; p1_last: string | null; p1_email: string | null; p1_phone: string | null; p1_ghl: string | null;
  p2_first: string | null; p2_last: string | null; p2_email: string | null; p2_phone: string | null; p2_ghl: string | null;
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExportPublic(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const { rows } = await query<ContactRow>(
    `SELECT CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS student,
            COALESCE(NULLIF(f.display_name, ''), '') AS family,
            s.metadata->>'program_name' AS program,
            s.metadata->>'homeroom' AS homeroom,
            s.metadata->>'unique_id' AS unique_id,
            s.metadata->>'household_id' AS household_id,
            s.metadata->>'student_street' AS street,
            s.metadata->>'student_city' AS city,
            s.metadata->>'student_state' AS state,
            s.metadata->>'student_zip' AS zip,
            p1.first_name AS p1_first, p1.last_name AS p1_last, p1.email AS p1_email, p1.phone AS p1_phone, p1.ghl_contact_id AS p1_ghl,
            p2.first_name AS p2_first, p2.last_name AS p2_last, p2.email AS p2_email, p2.phone AS p2_phone, p2.ghl_contact_id AS p2_ghl
       FROM students s
       JOIN families f ON f.id = s.family_id
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, email, phone, ghl_contact_id FROM parents
          WHERE family_id = f.id AND status = 'active'
          ORDER BY is_primary DESC, created_at ASC LIMIT 1
       ) p1 ON true
       LEFT JOIN LATERAL (
         SELECT first_name, last_name, email, phone, ghl_contact_id FROM parents
          WHERE family_id = f.id AND status = 'active'
          ORDER BY is_primary DESC, created_at ASC OFFSET 1 LIMIT 1
       ) p2 ON true
      WHERE s.school_id = $1 AND s.status = 'active'
      ORDER BY s.last_name, s.first_name`,
    [school.id],
  );

  const cols: CsvColumn<ContactRow>[] = [
    { key: 'student', label: 'Student' },
    { key: 'family', label: 'Family' },
    { key: 'program', label: 'Program', value: (r) => r.program ?? '' },
    { key: 'homeroom', label: 'Homeroom', value: (r) => r.homeroom ?? '' },
    { key: 'unique_id', label: 'Student ID', value: (r) => r.unique_id ?? '' },
    { key: 'household_id', label: 'Household ID', value: (r) => r.household_id ?? '' },
    { key: 'p1_first', label: 'Parent 1 First', value: (r) => r.p1_first ?? '' },
    { key: 'p1_last', label: 'Parent 1 Last', value: (r) => r.p1_last ?? '' },
    { key: 'p1_email', label: 'Parent 1 Email', value: (r) => r.p1_email ?? '' },
    { key: 'p1_phone', label: 'Parent 1 Phone', value: (r) => r.p1_phone ?? '' },
    { key: 'p2_first', label: 'Parent 2 First', value: (r) => r.p2_first ?? '' },
    { key: 'p2_last', label: 'Parent 2 Last', value: (r) => r.p2_last ?? '' },
    { key: 'p2_email', label: 'Parent 2 Email', value: (r) => r.p2_email ?? '' },
    { key: 'p2_phone', label: 'Parent 2 Phone', value: (r) => r.p2_phone ?? '' },
    { key: 'street', label: 'Street', value: (r) => r.street ?? '' },
    { key: 'city', label: 'City', value: (r) => r.city ?? '' },
    { key: 'state', label: 'State', value: (r) => r.state ?? '' },
    { key: 'zip', label: 'Zip', value: (r) => r.zip ?? '' },
    { key: 'p1_ghl', label: 'Parent 1 Growth Suite Contact ID', value: (r) => r.p1_ghl ?? '' },
    { key: 'p2_ghl', label: 'Parent 2 Growth Suite Contact ID', value: (r) => r.p2_ghl ?? '' },
  ];

  return csvResponse(`contacts-2026-27-${dateStamp()}.csv`, toCsv(rows, cols));
}
