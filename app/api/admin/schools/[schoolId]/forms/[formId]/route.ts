// PATCH /api/admin/schools/{schoolId}/forms/{formId}
//
// Saves metadata + field_schema for a portal_form_definitions row.
// Body (JSON): { meta, field_schema }
//
// We do basic shape validation server-side so a bad edit can't brick
// the form. We don't validate every option/label — we trust the
// editor UI to keep things sensible; if a bad value slips through,
// the renderer just doesn't show it.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string; formId: string }>;

interface Body {
  meta?: {
    display_name?: unknown;
    description?: unknown;
    category?: unknown;
    per_student?: unknown;
    is_active?: unknown;
    allow_addendum?: unknown;
    needs_review?: unknown;
    resubmission_allowed?: unknown;
    one_submission_per_year?: unknown;
  };
  field_schema?: unknown;
}

const ALLOWED_FIELD_TYPES = new Set([
  'header', 'paragraph', 'section',
  'text', 'email', 'tel', 'url', 'textarea', 'number', 'date',
  'select', 'radio', 'checkbox', 'multi_checkbox',
  'file_upload',
  'signature_drawn', 'signature_typed',
  'pricing_select', 'multi_pricing', 'quantity_pricing', 'tuition_calculator',
]);

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return fallback;
}
function asStr(v: unknown, fallback: string | null): string | null {
  if (typeof v === 'string') return v;
  return fallback;
}

function validateFieldSchema(raw: unknown): { ok: true; schema: unknown[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'field_schema must be an array' };
  const seenKeys = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (!b || typeof b !== 'object') return { ok: false, error: `Block #${i + 1} is not an object` };
    const block = b as Record<string, unknown>;
    const type = block.type;
    if (typeof type !== 'string' || !ALLOWED_FIELD_TYPES.has(type)) {
      return { ok: false, error: `Block #${i + 1} has invalid type: ${String(type)}` };
    }
    const isDisplayOnly = type === 'header' || type === 'paragraph' || type === 'section';
    if (!isDisplayOnly) {
      const key = block.key;
      if (typeof key !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(key)) {
        return { ok: false, error: `Block #${i + 1} (${type}) needs a valid field key (letters/numbers/underscore).` };
      }
      if (seenKeys.has(key)) {
        return { ok: false, error: `Duplicate field key: ${key}` };
      }
      seenKeys.add(key);
      const label = block.label;
      if (typeof label !== 'string' || label.trim() === '') {
        return { ok: false, error: `Block "${key}" needs a label.` };
      }
      // Choice fields must have at least one option
      if (type === 'select' || type === 'radio' || type === 'multi_checkbox'
          || type === 'pricing_select' || type === 'multi_pricing') {
        const opts = block.options;
        if (!Array.isArray(opts) || opts.length === 0) {
          return { ok: false, error: `Block "${key}" (${type}) needs at least one option.` };
        }
      }
    }
  }
  return { ok: true, schema: raw };
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;

  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  // Confirm the form exists and belongs to this school
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM portal_form_definitions WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (existing.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Validate field_schema
  if (body.field_schema !== undefined) {
    const result = validateFieldSchema(body.field_schema);
    if (!result.ok) {
      return NextResponse.json({ error: 'invalid_field_schema', detail: result.error }, { status: 400 });
    }
  }

  // Build the SET clause from whatever fields were sent
  const sets: string[] = [];
  const args: unknown[] = [];
  function set(col: string, val: unknown) {
    args.push(val);
    sets.push(`${col} = $${args.length}`);
  }

  if (body.meta) {
    if (body.meta.display_name !== undefined) {
      const s = asStr(body.meta.display_name, null);
      if (s && s.trim()) set('display_name', s.trim());
    }
    if (body.meta.description !== undefined) {
      set('description', asStr(body.meta.description, null));
    }
    if (body.meta.category !== undefined) {
      const s = asStr(body.meta.category, null);
      set('category', s && s.trim() ? s.trim() : null);
    }
    if (body.meta.per_student !== undefined)             set('per_student',            asBool(body.meta.per_student, false));
    if (body.meta.is_active !== undefined)               set('is_active',              asBool(body.meta.is_active, true));
    if (body.meta.allow_addendum !== undefined)          set('allow_addendum',         asBool(body.meta.allow_addendum, false));
    if (body.meta.needs_review !== undefined)            set('needs_review',           asBool(body.meta.needs_review, false));
    if (body.meta.resubmission_allowed !== undefined)    set('resubmission_allowed',   asBool(body.meta.resubmission_allowed, true));
    if (body.meta.one_submission_per_year !== undefined) set('one_submission_per_year',asBool(body.meta.one_submission_per_year, false));
  }
  if (body.field_schema !== undefined) {
    args.push(JSON.stringify(body.field_schema));
    sets.push(`field_schema = $${args.length}::jsonb`);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'no_changes' }, { status: 400 });
  }

  args.push(formId, schoolId);
  await query(
    `UPDATE portal_form_definitions
        SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${args.length - 1} AND school_id = $${args.length}`,
    args,
  );

  return NextResponse.json({ ok: true });
}
