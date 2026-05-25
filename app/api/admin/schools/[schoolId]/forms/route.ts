// POST /api/admin/schools/[schoolId]/forms
//
// Creates a new portal_form_definitions row from the New Form wizard.
// Picks a starter field_schema based on the chosen template — gives
// the operator a non-empty form to start editing in the editor.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;
type Template = 'blank' | 'parent_info' | 'signature_only' | 'health';

interface Body {
  slug: string;
  display_name: string;
  description?: string | null;
  category?: string | null;
  per_student?: boolean;
  template?: Template;
}

// Shared signature block — every template ends with this.
const SIGNATURE_BLOCKS = [
  {
    type: 'signature_drawn',
    key: 'parent_signature',
    label: 'Parent / guardian signature',
    required: true,
  },
  {
    type: 'date',
    key: 'signature_date',
    label: 'Date',
    required: true,
    prefill: 'today',
  },
];

const TEMPLATES: Record<Template, (displayName: string) => unknown[]> = {
  blank: (displayName) => [
    { type: 'header', text: displayName },
    ...SIGNATURE_BLOCKS,
  ],
  parent_info: (displayName) => [
    { type: 'header', text: displayName },
    { type: 'section', label: 'Your information' },
    { type: 'text', key: 'parent_first_name', label: 'First name', required: true, width: 'half', prefill: 'parent.first_name' },
    { type: 'text', key: 'parent_last_name',  label: 'Last name',  required: true, width: 'half', prefill: 'parent.last_name' },
    { type: 'email', key: 'parent_email', label: 'Email', required: true, prefill: 'parent.email' },
    { type: 'tel',   key: 'parent_phone', label: 'Phone', prefill: 'parent.phone' },
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
    { type: 'textarea', key: 'allergies', label: 'Allergies', rows: 2, placeholder: 'List any allergies, or "None".' },
    { type: 'textarea', key: 'medications', label: 'Current medications', rows: 2 },
    { type: 'textarea', key: 'medical_conditions', label: 'Medical conditions', rows: 2 },
    { type: 'section', label: 'Emergency contact' },
    { type: 'text', key: 'ec_name', label: 'Contact name', required: true, width: 'half' },
    { type: 'tel',  key: 'ec_phone', label: 'Contact phone', required: true, width: 'half' },
    { type: 'text', key: 'ec_relationship', label: 'Relationship to student', width: 'half' },
    ...SIGNATURE_BLOCKS,
  ],
};

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { schoolId } = await params;

  let body: Body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Validation
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

  // Verify school
  const { rows: schoolRows } = await query<{ id: string }>(
    `SELECT id FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) {
    return NextResponse.json({ error: 'school_not_found' }, { status: 404 });
  }

  // Pick the template
  const template: Template = body.template && TEMPLATES[body.template] ? body.template : 'blank';
  const fieldSchema = TEMPLATES[template](body.display_name.trim());

  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          field_schema, is_active, needs_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, true)
       RETURNING id`,
      [
        schoolId, slug,
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
