import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkServiceAuth, unauthorizedResponse } from '@/lib/auth/service';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

const UPDATABLE = ['display_name', 'description', 'is_enabled', 'position'] as const;

export async function GET(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId, dashboardId } = await params;
  const { rows } = await query(
    'SELECT * FROM school_dashboards WHERE id = $1 AND school_id = $2',
    [dashboardId, schoolId]
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ dashboard: rows[0] });
}

export async function PUT(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId, dashboardId } = await params;

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of UPDATABLE) {
    if (body[f] !== undefined) {
      values.push(body[f]);
      sets.push(`${f} = $${values.length}`);
    }
  }
  if (body.layout !== undefined) {
    if (!Array.isArray(body.layout)) {
      return NextResponse.json({ error: 'layout must be an array' }, { status: 400 });
    }
    values.push(JSON.stringify(body.layout));
    sets.push(`layout = $${values.length}::jsonb`);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
  }
  sets.push('updated_at = now()');
  values.push(dashboardId);
  values.push(schoolId);

  const { rows } = await query(
    `UPDATE school_dashboards SET ${sets.join(', ')}
       WHERE id = $${values.length - 1} AND school_id = $${values.length}
       RETURNING *`,
    values
  );
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ dashboard: rows[0] });
}

export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId, dashboardId } = await params;
  const { rowCount } = await query(
    'DELETE FROM school_dashboards WHERE id = $1 AND school_id = $2',
    [dashboardId, schoolId]
  );
  if (rowCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
