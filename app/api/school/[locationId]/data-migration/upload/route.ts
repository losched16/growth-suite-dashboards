// POST /api/school/{locationId}/data-migration/upload  (multipart: file)
// Parse an uploaded CSV, auto-propose a column → GHL-field mapping against the
// school's own catalog, store it, and redirect to the review page. Read-only
// w.r.t. GHL — nothing is written until the operator reviews + applies.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';
import { parseCsv, columnSamples, proposeMapping } from '@/lib/migration/csv-mapping';
import { loadMigrationTargets } from '@/lib/migration/targets';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = Promise<{ locationId: string }>;

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ROWS = 5000;
const SAMPLE_ROWS_KEPT = 25;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  const auth = await authorizeOperatorOrSchool(school.id);
  if (!auth.ok) return auth.response;

  const back = (q: { id?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = q.id ? `/school/${locationId}/data-migration/${q.id}` : `/school/${locationId}/data-migration`;
    url.search = '';
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return back({ err: 'Choose a CSV file to upload.' });
    if (file.size === 0) return back({ err: 'That file is empty.' });
    if (file.size > MAX_BYTES) return back({ err: `File too large (max ${MAX_BYTES / 1024 / 1024} MB).` });

    const text = await file.text();
    const parsed = parseCsv(text, MAX_ROWS);
    if (parsed.columns.length === 0) return back({ err: 'Could not read any columns from that file.' });
    if (parsed.rows.length === 0) return back({ err: 'That file has a header but no data rows.' });

    const samplesByColumn: Record<string, string[]> = {};
    for (const c of parsed.columns) samplesByColumn[c] = columnSamples(parsed.rows, c, 8);

    const targets = await loadMigrationTargets(school.id);
    const mapping = proposeMapping(parsed.columns, samplesByColumn, targets);

    const columnsMeta = parsed.columns.map((name) => ({ name, sample_values: samplesByColumn[name] }));
    const filename = 'name' in file && typeof file.name === 'string' ? file.name.slice(0, 200) : 'upload.csv';

    const { rows: ins } = await query<{ id: string }>(
      `INSERT INTO csv_migrations (school_id, filename, columns, row_count, rows, mapping, status)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, 'proposed')
       RETURNING id`,
      [school.id, filename, JSON.stringify(columnsMeta), parsed.rows.length, JSON.stringify(parsed.rows), JSON.stringify(mapping)],
    );
    return back({ id: ins[0].id });
  } catch (err) {
    return back({ err: `Upload failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
