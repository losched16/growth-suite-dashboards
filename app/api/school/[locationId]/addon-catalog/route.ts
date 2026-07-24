// School-facing save for the tuition add-on rate card
// (schools.settings.addon_catalog). School-scoped (school session OR
// operator). JSON in / JSON out — driven by the AddonCatalogEditor client
// component's fetch(). The amount signs are already applied client-side
// (deposit = negative); normalizeCatalog re-validates + dedupes here.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { saveAddonCatalog, normalizeCatalog } from '@/lib/billing/addon-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const authorized = isOperator || (schoolSession && schoolSession.school_id === school.id);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    // Resolve the school from the URL locationId — never trust a schoolId in
    // the body.
    const catalog = normalizeCatalog((body as { catalog?: unknown }).catalog);
    await saveAddonCatalog(school.id, catalog);
    return NextResponse.json({
      ok: true,
      counts: {
        extended_care: catalog.extended_care.length,
        deposit: catalog.deposit.length,
        development_fee: catalog.development_fee.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'save_failed' },
      { status: 500 },
    );
  }
}
