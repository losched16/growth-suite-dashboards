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
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

// Authorize a DELETE for `schoolId`. Accepts EITHER:
//   - operator session (back-office /admin pages), or
//   - a school session for the SAME school (embedded /school pages
//     under GHL). Anything else → 401/403.
async function authorizeFormMutation(schoolId: string): Promise<{ ok: true } | { ok: false; status: 401 | 403 }> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return { ok: true };
  }
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss && ss.school_id === schoolId) {
    return { ok: true };
  }
  return { ok: false, status: ss ? 403 : 401 };
}

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
    // migration 040 — test-mode + custom thank-you
    confirmation_message?: unknown;
    confirmation_redirect_url?: unknown;
    notify_emails?: unknown;
    // migration 060 — per-form master switch for notify email fan-out
    notifications_enabled?: unknown;
    // migration 042 — webhook fan-out (automation triggers)
    webhook_urls?: unknown;
    // per-student form visibility rule (portal_form_definitions.applies_to).
    // null / {} → form shows for every student (historical behavior).
    applies_to?: unknown;
  };
  field_schema?: unknown;
}

// Normalize an inbound applies_to rule. Returns the cleaned object, or
// null when the rule is absent/empty (meaning "show to every student").
// We only keep the criteria the visibility engine understands and drop
// anything blank, so a half-filled UI selection can't accidentally
// hide a form. Mirrors lib/forms/applies-to.ts in the parent portal.
function sanitizeAppliesTo(raw: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'applies_to must be null or an object' };
  }
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];

  const pm = strArray(r.program_match);
  if (pm.length) out.program_match = pm;
  const tm = strArray(r.tag_match);
  if (tm.length) out.tag_match = tm;
  const tg = strArray(r.tuition_grid_match);
  if (tg.length) out.tuition_grid_match = tg;
  const ak = strArray(r.addon_keys);
  if (ak.length) out.addon_keys = ak;
  const si = strArray(r.student_ids);
  if (si.length) out.student_ids = si;
  if (r.metadata_match && typeof r.metadata_match === 'object' && !Array.isArray(r.metadata_match)) {
    const mm: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(r.metadata_match as Record<string, unknown>)) {
      const vals = strArray(v);
      if (vals.length) mm[k] = vals;
    }
    if (Object.keys(mm).length) out.metadata_match = mm;
  }

  // No usable criteria → treat as "all students" (NULL).
  return { ok: true, value: Object.keys(out).length ? out : null };
}

const ALLOWED_FIELD_TYPES = new Set([
  'header', 'paragraph', 'section',
  'text', 'email', 'tel', 'url', 'textarea', 'number', 'date',
  'select', 'radio', 'checkbox', 'multi_checkbox',
  'file_upload',
  'signature_drawn', 'signature_typed', 'signature_stamp',
  'pricing_select', 'multi_pricing', 'quantity_pricing', 'tuition_calculator',
  'student_picker',
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
    // signature_stamp is a pre-signed Head-of-School stamp — display-only,
    // no key/label/input (same as header/paragraph/section).
    const isDisplayOnly = type === 'header' || type === 'paragraph' || type === 'section' || type === 'signature_stamp';
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
    // Phase 1 test-mode additions (migration 040)
    if (body.meta.confirmation_message !== undefined) {
      set('confirmation_message', asStr(body.meta.confirmation_message, null));
    }
    if (body.meta.confirmation_redirect_url !== undefined) {
      const raw = asStr(body.meta.confirmation_redirect_url, null);
      // Allow only http(s) URLs to avoid javascript: / data: redirects.
      const url = raw && /^https?:\/\//i.test(raw.trim()) ? raw.trim() : null;
      set('confirmation_redirect_url', url);
    }
    if (body.meta.notify_emails !== undefined) {
      const arr = Array.isArray(body.meta.notify_emails) ? body.meta.notify_emails : [];
      const cleaned = arr
        .map((v) => String(v ?? '').trim().toLowerCase())
        .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
      args.push(cleaned);
      sets.push(`notify_emails = $${args.length}::text[]`);
    }
    if (body.meta.notifications_enabled !== undefined) {
      args.push(body.meta.notifications_enabled === true || body.meta.notifications_enabled === 'true');
      sets.push(`notifications_enabled = $${args.length}::boolean`);
    }
    if (body.meta.webhook_urls !== undefined) {
      const arr = Array.isArray(body.meta.webhook_urls) ? body.meta.webhook_urls : [];
      // HTTPS only — reject http/ftp/javascript/data schemes.
      const cleaned = arr
        .map((v) => String(v ?? '').trim())
        .filter((v) => /^https:\/\/[^\s]+$/i.test(v));
      args.push(cleaned);
      sets.push(`webhook_urls = $${args.length}::text[]`);
    }
    if (body.meta.applies_to !== undefined) {
      const res = sanitizeAppliesTo(body.meta.applies_to);
      if (!res.ok) {
        return NextResponse.json({ error: 'invalid_applies_to', detail: res.error }, { status: 400 });
      }
      // null → NULL::jsonb (show to everyone); object → stored rule.
      args.push(res.value === null ? null : JSON.stringify(res.value));
      sets.push(`applies_to = $${args.length}::jsonb`);
    }
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

// DELETE /api/admin/schools/{schoolId}/forms/{formId}[?confirm_count=N]
//
// Hard-deletes a portal form definition. The FK from
// portal_form_submissions → portal_form_definitions cascades, so
// submissions/migration_flags/enrollment_invites are wiped together.
//
// Defense in depth:
//   - Requires the operator session cookie (back-office only — the
//     plain PATCH endpoint above is unauthenticated by legacy, but
//     deletion is destructive enough to warrant the gate).
//   - `confirm_count` URL param must equal the current submission
//     count. Stops the obvious TOCTOU: operator opens the list when
//     N=0, a parent submits while they're deciding, the operator
//     clicks delete and silently destroys that submission. Mismatch
//     returns 409 so the caller can refresh and re-confirm.
//   - Soft delete (set is_active=false) is the kinder option for
//     forms with submissions — staff should usually flip "Published"
//     off rather than delete. This endpoint exists for the cases
//     where they really do want it gone (typo'd form, abandoned
//     draft, etc.).
export async function DELETE(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorizeFormMutation(schoolId);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  const expectedCountRaw = new URL(request.url).searchParams.get('confirm_count');
  const expectedCount = expectedCountRaw != null && /^\d+$/.test(expectedCountRaw)
    ? Number(expectedCountRaw)
    : null;
  if (expectedCount == null) {
    return NextResponse.json({
      error: 'missing_confirm_count',
      detail: 'Pass ?confirm_count=N where N is the current submission count, fetched immediately before delete.',
    }, { status: 400 });
  }

  // Lock the row so a concurrent submission can't slip in between the
  // count read and the delete. Single-statement DELETE is atomic, so
  // technically the FOR UPDATE is belt-and-suspenders — but for a
  // destructive op the extra round trip is cheap insurance.
  const def = await query<{ id: string; display_name: string; slug: string }>(
    `SELECT id, display_name, slug FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2 FOR UPDATE`,
    [formId, schoolId],
  );
  if (def.rows.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const cnt = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM portal_form_submissions WHERE form_definition_id = $1`,
    [formId],
  );
  const actualCount = Number(cnt.rows[0]?.n ?? 0);
  if (actualCount !== expectedCount) {
    return NextResponse.json({
      error: 'submission_count_mismatch',
      detail: `Expected ${expectedCount} submissions, found ${actualCount}. Refresh the page and re-confirm.`,
      actual: actualCount,
    }, { status: 409 });
  }

  await query(
    `DELETE FROM portal_form_definitions WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );

  return NextResponse.json({
    ok: true,
    deleted: { id: formId, slug: def.rows[0].slug, display_name: def.rows[0].display_name },
    cascaded_submissions: actualCount,
  });
}
