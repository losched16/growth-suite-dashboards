// POST /api/admin/schools/{schoolId}/forms/{formId}/duplicate
//
// Clones a portal_form_definitions row into a new draft. Submissions
// and migration flags do NOT come along — we copy the definition only.
// The clone lands as a draft (`is_active=false`) so it can't surface
// in the parent portal until the operator is ready.
//
// The new slug is `<original-slug>-copy`, deduped with `-2`, `-3`, etc.
// if there's already a copy. Display name gets " (Copy)" appended.
//
// Auth: NONE. Matches the PATCH endpoint's posture — duplicate is
// fully non-destructive (creates a draft, hidden from parents until
// the operator publishes), so trying to gate it inside a GHL-embedded
// iframe (where the school-session cookie state is inconsistent)
// causes more pain than it prevents. Worst case for the gate-free
// posture: an attacker who already has /school/<loc>/payments access
// creates a draft. They could already PATCH any field on the
// original. Delete is the only thing that actually warrants the gate.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; formId: string }>;

// Find a slug that isn't already taken inside this school. We try
// `<slug>-copy`, then `-copy-2`, `-copy-3`, ... up to a safety cap.
async function uniqueSlug(schoolId: string, baseSlug: string): Promise<string> {
  const base = `${baseSlug}-copy`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM portal_form_definitions WHERE school_id = $1 AND slug = $2`,
      [schoolId, candidate],
    );
    if (rows.length === 0) return candidate;
  }
  // Extremely unlikely. Fall back to timestamp suffix.
  return `${base}-${Date.now().toString(36)}`;
}

export async function POST(_request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;

  // Read the source row. We re-select every column so a future
  // ALTER TABLE doesn't silently drop fields from the clone.
  const { rows } = await query<{
    slug: string;
    display_name: string;
    description: string | null;
    category: string | null;
    per_student: boolean;
    required_for: string | null;
    field_schema: unknown;
    ghl_writeback: unknown;
    one_submission_per_year: boolean;
    resubmission_allowed: boolean;
    fee_amount: string | null;
    admin_notes: string | null;
    needs_review: boolean;
    legacy_completion_field_key: string | null;
    payment_config: unknown;
    allow_addendum: boolean;
    confirmation_message: string | null;
    confirmation_redirect_url: string | null;
    notify_emails: string[];
    webhook_urls: string[];
    audience: string;
    applies_to: unknown;
  }>(
    `SELECT slug, display_name, description, category, per_student,
            required_for, field_schema, ghl_writeback,
            one_submission_per_year, resubmission_allowed, fee_amount,
            admin_notes, needs_review, legacy_completion_field_key,
            payment_config, allow_addendum,
            confirmation_message, confirmation_redirect_url,
            notify_emails, webhook_urls, audience, applies_to
       FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const src = rows[0];

  const newSlug = await uniqueSlug(schoolId, src.slug);
  const newDisplay = `${src.display_name} (Copy)`;

  const { rows: inserted } = await query<{ id: string; slug: string }>(
    `INSERT INTO portal_form_definitions (
       school_id, slug, display_name, description, category,
       per_student, required_for, is_active,
       field_schema, ghl_writeback,
       one_submission_per_year, resubmission_allowed, fee_amount,
       admin_notes, needs_review, legacy_completion_field_key,
       payment_config, allow_addendum,
       confirmation_message, confirmation_redirect_url,
       notify_emails, webhook_urls,
       audience, applies_to
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, false,
       $8::jsonb, $9::jsonb,
       $10, $11, $12,
       $13, $14, $15,
       $16::jsonb, $17,
       $18, $19,
       $20::text[], $21::text[],
       $22, $23::jsonb
     )
     RETURNING id, slug`,
    [
      schoolId, newSlug, newDisplay, src.description, src.category,
      src.per_student, src.required_for,
      JSON.stringify(src.field_schema ?? []), JSON.stringify(src.ghl_writeback ?? {}),
      src.one_submission_per_year, src.resubmission_allowed, src.fee_amount,
      src.admin_notes, src.needs_review, src.legacy_completion_field_key,
      src.payment_config == null ? null : JSON.stringify(src.payment_config), src.allow_addendum,
      src.confirmation_message, src.confirmation_redirect_url,
      src.notify_emails ?? [], src.webhook_urls ?? [],
      src.audience, src.applies_to == null ? null : JSON.stringify(src.applies_to),
    ],
  );

  return NextResponse.json({
    ok: true,
    id: inserted[0].id,
    slug: inserted[0].slug,
    display_name: newDisplay,
  });
}
