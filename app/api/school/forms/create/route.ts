// POST /api/school/forms/create
//
// School-iframe-context version of /api/admin/schools/[schoolId]/forms.
// Identical logic, but uses the school session (auto-minted by the
// proxy from the locationId in the URL) rather than the operator
// session. Lets admins create new portal forms from the Payments hub's
// Forms tab without escaping the iframe to the deep-admin route.
//
// Templates intentionally duplicated from
// app/api/admin/schools/[schoolId]/forms/route.ts to keep both routes
// self-contained for now. If/when a third caller needs them, lift the
// TEMPLATES map into lib/forms/templates.ts.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Template = 'blank' | 'parent_info' | 'signature_only' | 'health';

interface Body {
  slug: string;
  display_name: string;
  description?: string | null;
  category?: string | null;
  per_student?: boolean;
  template?: Template;
}

const SIGNATURE_BLOCKS = [
  { type: 'signature_drawn', key: 'parent_signature', label: 'Parent / guardian signature', required: true },
  { type: 'date',            key: 'signature_date',   label: 'Date',                        required: true, prefill: 'today' },
];

const TEMPLATES: Record<Template, (displayName: string) => unknown[]> = {
  blank: (displayName) => [
    { type: 'header', text: displayName },
    ...SIGNATURE_BLOCKS,
  ],
  parent_info: (displayName) => [
    { type: 'header', text: displayName },
    { type: 'section', label: 'Your information' },
    { type: 'text',  key: 'parent_first_name', label: 'First name', required: true, width: 'half', prefill: 'parent.first_name' },
    { type: 'text',  key: 'parent_last_name',  label: 'Last name',  required: true, width: 'half', prefill: 'parent.last_name' },
    { type: 'email', key: 'parent_email',      label: 'Email',      required: true, prefill: 'parent.email' },
    { type: 'tel',   key: 'parent_phone',      label: 'Phone',      prefill: 'parent.phone' },
    ...SIGNATURE_BLOCKS,
  ],
  signature_only: (displayName) => [
    { type: 'header', text: displayName },
    {
      type: 'paragraph',
      text: 'By signing below, I acknowledge that I have read and agree to the terms outlined here.',
      emphasis: 'note',
    },
    ...SIGNATURE_BLOCKS,
  ],
  health: (displayName) => [
    { type: 'header', text: displayName },
    { type: 'section', label: 'Allergies & medical conditions' },
    { type: 'textarea', key: 'allergies',          label: 'Allergies',           rows: 2, placeholder: 'List any allergies, or "None".' },
    { type: 'textarea', key: 'medications',        label: 'Current medications', rows: 2 },
    { type: 'textarea', key: 'medical_conditions', label: 'Medical conditions',  rows: 2 },
    { type: 'section', label: 'Emergency contact' },
    { type: 'text', key: 'ec_name',         label: 'Contact name', required: true, width: 'half' },
    { type: 'tel',  key: 'ec_phone',        label: 'Contact phone', required: true, width: 'half' },
    { type: 'text', key: 'ec_relationship', label: 'Relationship to student', width: 'half' },
    ...SIGNATURE_BLOCKS,
  ],
};

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const slug = (body.slug ?? '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json(
      { error: 'invalid_slug', detail: 'Slug must be lowercase letters, numbers, and hyphens.' },
      { status: 400 },
    );
  }
  if (!body.display_name?.trim()) {
    return NextResponse.json({ error: 'missing_display_name' }, { status: 400 });
  }

  const template: Template = body.template && TEMPLATES[body.template] ? body.template : 'blank';
  const fieldSchema = TEMPLATES[template](body.display_name.trim());

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          field_schema, is_active, needs_review, audience)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, true, 'parents')
       RETURNING id`,
      [
        session.school_id, slug,
        body.display_name.trim(),
        body.description ?? null,
        body.category ?? null,
        !!body.per_student,
        JSON.stringify(fieldSchema),
      ],
    );
    return NextResponse.json({ ok: true, id: rows[0].id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('portal_form_definitions') && msg.includes('unique')) {
      return NextResponse.json(
        { error: 'duplicate_slug', detail: `A form with slug "${slug}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'insert_failed', detail: msg }, { status: 500 });
  }
}
