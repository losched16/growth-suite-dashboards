// POST /api/school/{locationId}/forms/from-template
// Body (form): template=<key>
//
// Creates a DRAFT form (is_active=false) from a generic starter template and
// redirects straight into the form builder to edit it. Slug is deduped with a
// numeric suffix so re-adding a template never collides. Additive only —
// existing forms are never touched.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FORM_TEMPLATES } from '@/lib/forms/templates';
import { query } from '@/lib/db';

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

  const form = await request.formData().catch(() => null);
  const key = String(form?.get('template') ?? '').trim();
  const template = FORM_TEMPLATES.find((t) => t.key === key);
  if (!template) {
    return NextResponse.redirect(new URL(`/school/${locationId}/forms/new?err=unknown_template`, request.nextUrl), 303);
  }

  try {
    // Dedupe the slug against this school's existing forms.
    const { rows: existing } = await query<{ slug: string }>(
      `SELECT slug FROM portal_form_definitions WHERE school_id = $1`,
      [school.id],
    );
    const have = new Set(existing.map((r) => r.slug));
    let slug = template.key;
    for (let n = 2; have.has(slug); n++) slug = `${template.key}-${n}`;

    const { rows: ins } = await query<{ id: string }>(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          field_schema, is_active, resubmission_allowed)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, true)
       RETURNING id`,
      [school.id, slug, template.title, template.description, template.category,
       template.per_student, JSON.stringify(template.field_schema)],
    );

    // Straight into the builder — it's a draft until the school publishes it.
    return NextResponse.redirect(
      new URL(`/school/${locationId}/forms/${ins[0].id}/builder`, request.nextUrl), 303);
  } catch (err) {
    const url = new URL(`/school/${locationId}/forms/new`, request.nextUrl);
    url.searchParams.set('err', err instanceof Error ? err.message : String(err));
    return NextResponse.redirect(url, 303);
  }
}
