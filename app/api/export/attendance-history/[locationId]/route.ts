// CSV export — per-student attendance history.
//
// GET /api/export/attendance-history/{locationId}?student=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Same range the attendance-history page displays. Requires school
// session or embed token (signatures are flagged, not embedded).

import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import {
  authorizeExport, unauthorizedCsvResponse, notFoundCsvResponse,
  csvResponse, toCsv, type CsvColumn,
} from '@/lib/exports/csv';

type Params = Promise<{ locationId: string }>;

const TZ = 'America/Phoenix';

interface Row {
  performed_at: string;
  event_type: string;
  performed_by_name_snapshot: string | null;
  performed_by_admin_email: string | null;
  picked_up_by_name_snapshot: string | null;
  source: string | null;
  curbside: boolean;
  curbside_slot: string | null;
  pickup_time: string | null;
  notes: string | null;
  has_signature: boolean;
}

const COLUMNS: CsvColumn<Row>[] = [
  { key: 'date', label: 'Date', value: (r) => new Date(r.performed_at).toLocaleDateString('en-CA', { timeZone: TZ }) },
  { key: 'time', label: 'Time', value: (r) => new Date(r.performed_at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) },
  { key: 'event', label: 'Event', value: (r) => r.event_type },
  { key: 'by', label: 'Performed by', value: (r) => r.performed_by_admin_email ? `${r.performed_by_admin_email} (office)` : (r.performed_by_name_snapshot ?? '') },
  { key: 'picked_up_by', label: 'Picked up by', value: (r) => r.picked_up_by_name_snapshot ?? '' },
  { key: 'source', label: 'Source', value: (r) => r.source ?? '' },
  { key: 'curbside', label: 'Curbside', value: (r) => (r.curbside ? (r.curbside_slot ?? 'yes') : '') },
  { key: 'pickup_time', label: 'Pickup time', value: (r) => r.pickup_time ?? '' },
  { key: 'notes', label: 'Notes', value: (r) => r.notes ?? '' },
  { key: 'signature', label: 'Signature on file', value: (r) => (r.has_signature ? 'yes' : 'no') },
];

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await authorizeExport(request, locationId);
  if (!school) return unauthorizedCsvResponse();

  const sp = request.nextUrl.searchParams;
  const studentId = sp.get('student') ?? '';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(studentId) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return notFoundCsvResponse();
  }

  const { rows: sRows } = await query<{ name: string }>(
    `SELECT CONCAT_WS(' ', COALESCE(NULLIF(preferred_name, ''), first_name), last_name) AS name
       FROM students WHERE id = $1 AND school_id = $2`,
    [studentId, school.id],
  );
  if (!sRows[0]) return notFoundCsvResponse();

  const { rows } = await query<Row>(
    `SELECT performed_at, event_type,
            performed_by_name_snapshot, performed_by_admin_email,
            picked_up_by_name_snapshot, source, curbside, curbside_slot,
            pickup_time, notes,
            signature_png IS NOT NULL AND signature_png <> '' AS has_signature
       FROM attendance_events
      WHERE student_id = $1 AND school_id = $2
        AND performed_at >= ($3::date::timestamptz)
        AND performed_at < (($4::date + 1)::timestamptz)
      ORDER BY performed_at ASC
      LIMIT 5000`,
    [studentId, school.id, from, to],
  );

  const safeName = sRows[0].name.replace(/[^\w -]/g, '');
  return csvResponse(`attendance ${safeName} ${from} to ${to}.csv`, toCsv(rows, COLUMNS));
}
