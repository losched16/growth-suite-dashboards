import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { authorizeOperatorOrSchool } from '@/lib/auth/dual';

type Params = Promise<{ schoolId: string; dashboardId: string }>;

// Reorder: swap this dashboard's position with its neighbor in the
// requested direction. Idempotent — silently no-ops if already at edge.
export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, dashboardId } = await params;
  const _auth = await authorizeOperatorOrSchool(schoolId);
  if (!_auth.ok) return _auth.response;
  const form = await request.formData();
  const dir = String(form.get('dir') ?? '').trim(); // 'up' | 'down'

  await withTransaction(async (q) => {
    const { rows } = await q<{ id: string; position: number }>(
      `SELECT id, position FROM school_dashboards
         WHERE id = $1 AND school_id = $2`,
      [dashboardId, schoolId]
    );
    if (rows.length === 0) return;
    const current = rows[0];

    const op = dir === 'up' ? '<' : '>';
    const order = dir === 'up' ? 'DESC' : 'ASC';
    const { rows: neighborRows } = await q<{ id: string; position: number }>(
      `SELECT id, position FROM school_dashboards
         WHERE school_id = $1 AND position ${op} $2
         ORDER BY position ${order} LIMIT 1`,
      [schoolId, current.position]
    );
    if (neighborRows.length === 0) return; // edge — no-op
    const neighbor = neighborRows[0];

    // Two-step swap to dodge the (school_id, position) collision —
    // we don't have a unique constraint on position but stay tidy anyway.
    await q(
      `UPDATE school_dashboards SET position = $1 WHERE id = $2`,
      [neighbor.position, current.id]
    );
    await q(
      `UPDATE school_dashboards SET position = $1 WHERE id = $2`,
      [current.position, neighbor.id]
    );
  });

  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  return NextResponse.redirect(url, 303);
}
