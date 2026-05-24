import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkServiceAuth, unauthorizedResponse } from '@/lib/auth/service';
import { query } from '@/lib/db';
import { provisionDefaults } from '@/lib/dashboards/provision';

type Params = Promise<{ schoolId: string }>;

// POST /api/v1/schools/{schoolId}/provision-defaults
// Idempotent: creates rows for any of the 7 default dashboards that don't
// exist yet. Returns which were created and which were skipped.
export async function POST(request: NextRequest, { params }: { params: Params }) {
  if (!checkServiceAuth(request)) return unauthorizedResponse();
  const { schoolId } = await params;

  const { rows } = await query<{ id: string }>(
    'SELECT id FROM schools WHERE id = $1',
    [schoolId]
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'school not found' }, { status: 404 });
  }

  const result = await provisionDefaults(schoolId);
  return NextResponse.json(result, { status: 200 });
}
