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
import { after } from 'next/server';
import { cookies } from 'next/headers';
import { query, withTransaction } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { resolveRecipients, sanitizeAudience, summarizeAudience } from '@/lib/notifications/audience';
import { loadGhlClient } from '@/lib/ghl/client';

// Authorize a DELETE for `schoolId`. Accepts EITHER:
//   - operator session (back-office /admin pages), or
//   - a school session for the SAME school (embedded /school pages
//     under GHL). Anything else → 401/403.
async function authorizeFormMutation(
  schoolId: string,
  // The form builder opens in a NEW TAB from the CRM iframe, where the
  // partitioned session cookie doesn't follow — saves 401'd ("forms are
  // not being saved", Sonia). The builder pages derive a per-school
  // embed token server-side and send it with every save; accept it here
  // like the documents/uploads routes do.
  embedToken?: string | null,
): Promise<{ ok: true } | { ok: false; status: 401 | 403 }> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return { ok: true };
  }
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss && ss.school_id === schoolId) {
    return { ok: true };
  }
  if (embedToken) {
    const { rows } = await query<{ ghl_location_id: string | null }>(
      `SELECT ghl_location_id FROM schools WHERE id = $1`, [schoolId]);
    const loc = rows[0]?.ghl_location_id;
    if (loc && checkEmbedToken(loc, embedToken)) return { ok: true };
  }
  return { ok: false, status: ss ? 403 : 401 };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Publish-notification email fan-out (via after()) can take ~2 minutes
// for a school-wide form — keep the function alive long enough.
export const maxDuration = 300;

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
  // tag_exclude was silently DROPPED here before — a builder save of a
  // form using it would collapse the rule and show the form to everyone.
  const tx = strArray(r.tag_exclude);
  if (tx.length) out.tag_exclude = tx;
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
  // Per-student metadata EXCLUSION (same shape as metadata_match).
  if (r.metadata_exclude && typeof r.metadata_exclude === 'object' && !Array.isArray(r.metadata_exclude)) {
    const mx: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(r.metadata_exclude as Record<string, unknown>)) {
      const vals = strArray(v);
      if (vals.length) mx[k] = vals;
    }
    if (Object.keys(mx).length) out.metadata_exclude = mx;
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

// Map a form's applies_to rule to a notification audience. The three
// rule types the builder's "Who sees this form" UI produces (program,
// grade_level, tag) translate 1:1; OR semantics on both sides. Rules
// this can't express (student_ids, tuition_grid, other metadata keys)
// return null → no auto-notification, publish still succeeds.
function audienceForAppliesTo(appliesTo: unknown): unknown | null {
  if (!appliesTo || typeof appliesTo !== 'object' || Array.isArray(appliesTo)) {
    return { match: 'any', conditions: [{ field: 'all' }] };
  }
  const r = appliesTo as Record<string, unknown>;
  const conds: Array<{ field: string; values?: string[] }> = [];
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  if (arr(r.program_match).length) conds.push({ field: 'program', values: arr(r.program_match) });
  const mm = (r.metadata_match ?? {}) as Record<string, unknown>;
  if (arr(mm.grade_level).length) conds.push({ field: 'grade_level', values: arr(mm.grade_level) });
  if (arr(r.tag_match).length) conds.push({ field: 'tag', values: arr(r.tag_match) });
  return conds.length ? { match: 'any', conditions: conds } : null;
}

export async function PATCH(request: NextRequest, { params }: { params: Params }) {
  const { schoolId, formId } = await params;
  const auth = await authorizeFormMutation(schoolId, request.nextUrl.searchParams.get('embed_token'));
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  let body: Body = {};
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  // Confirm the form exists and belongs to this school; remember the
  // pre-save publish state so we can detect the draft → published flip.
  const { rows: existing } = await query<{ id: string; is_active: boolean }>(
    `SELECT id, is_active FROM portal_form_definitions WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  if (existing.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const wasActive = existing[0].is_active;

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

  // Draft → published: tell exactly the families the form targets that
  // something new is waiting in their portal (bell + inbox). Best-effort
  // — a notification hiccup must never fail the publish itself.
  let notified = 0;
  if (asBool(body.meta?.is_active, false) === true && !wasActive) {
    try {
      const { rows: defRows } = await query<{ display_name: string; slug: string; applies_to: unknown }>(
        `SELECT display_name, slug, applies_to FROM portal_form_definitions WHERE id = $1`,
        [formId],
      );
      const def = defRows[0];
      const title = `New form: ${def.display_name}`;

      // Dedupe: a re-publish within 14 days (accidental toggle, quick
      // edit cycle) must not re-blast every family.
      const { rows: dup } = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM portal_notifications
          WHERE school_id = $1 AND title = $2 AND created_at > now() - interval '14 days'`,
        [schoolId, title],
      );
      if (Number(dup[0].n) === 0) {
        const audience = sanitizeAudience(audienceForAppliesTo(def.applies_to));
        if (audience) {
          const recipients = await resolveRecipients(schoolId, audience);
          if (recipients.length > 0) {
            const { rows: hostRows } = await query<{ custom_host: string | null }>(
              `SELECT custom_host FROM school_branding WHERE school_id = $1`,
              [schoolId],
            );
            const host = hostRows[0]?.custom_host?.trim();
            const linkUrl = host ? `https://${host}/forms-v2/${def.slug}` : null;
            await withTransaction(async (q) => {
              const { rows } = await q<{ id: string }>(
                `INSERT INTO portal_notifications
                   (school_id, title, body, link_url, link_label, pinned, audience, audience_label, recipient_count, created_by_email)
                 VALUES ($1, $2, $3, $4, $5, false, $6::jsonb, $7, $8, $9)
                 RETURNING id`,
                [schoolId, title,
                 `"${def.display_name}" has been published to your parent portal. Please open it and complete it when you have a moment.`,
                 linkUrl, linkUrl ? 'Open the form' : null,
                 JSON.stringify(audience), summarizeAudience(audience), recipients.length, 'auto: form published'],
              );
              await q(
                `INSERT INTO portal_notification_recipients (notification_id, school_id, parent_id, family_id)
                 SELECT $1, $2, pid, fid FROM unnest($3::uuid[], $4::uuid[]) AS t(pid, fid)
                 ON CONFLICT (notification_id, parent_id) DO NOTHING`,
                [rows[0].id, schoolId, recipients.map((r) => r.parent_id), recipients.map((r) => r.family_id)],
              );
            });
            notified = recipients.length;

            // EMAIL each recipient too — parents need a heads-up to even
            // open the portal (Clint, Aug 3). Sent through the school's
            // CRM so every email lands in the contact's conversation
            // history. Runs via after() so the builder's publish click
            // returns immediately while the fan-out completes (after()
            // keeps the function alive — a naked detached promise would
            // not survive the response).
            const emailBody = `<p>Hi {first},</p>
<p>A new form — <strong>${def.display_name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong> — has been published to your parent portal and needs your attention.</p>
${linkUrl ? `<p><a href="${linkUrl}">Open the form</a> — or log in to your parent portal and find it under your forms.</p>` : '<p>Please log in to your parent portal and find it under your forms.</p>'}
<p>Thank you!</p>`;
            const parentIds = [...new Set(recipients.map((r) => r.parent_id))];
            after(async () => {
              try {
                const { rows: pRows } = await query<{ id: string; first_name: string | null; ghl_contact_id: string | null }>(
                  `SELECT id, first_name, ghl_contact_id FROM parents
                    WHERE id = ANY($1::uuid[]) AND ghl_contact_id IS NOT NULL`,
                  [parentIds],
                );
                const seen = new Set<string>();
                const ghl = await loadGhlClient(schoolId);
                let sent = 0, failed = 0;
                for (const p of pRows) {
                  if (!p.ghl_contact_id || seen.has(p.ghl_contact_id)) continue;
                  seen.add(p.ghl_contact_id);
                  try {
                    await ghl.axios.post('/conversations/messages', {
                      type: 'Email',
                      contactId: p.ghl_contact_id,
                      subject: `New form to complete: ${def.display_name}`,
                      html: emailBody.replace('{first}', (p.first_name ?? 'there')
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;')),
                    }, { headers: { Version: '2021-04-15' } });
                    sent++;
                  } catch (e) {
                    failed++;
                    console.error(`[publish-notify] email to contact ${p.ghl_contact_id} failed:`,
                      e instanceof Error ? e.message : String(e));
                  }
                  await new Promise((r) => setTimeout(r, 350));
                }
                console.log(`[publish-notify] "${def.display_name}": emailed ${sent}, failed ${failed}`);
              } catch (e) {
                console.error('[publish-notify] email fan-out failed:', e);
              }
            });
          }
        }
      }
    } catch (e) {
      console.error('publish notification failed (form still published):', e);
    }
  }

  return NextResponse.json({ ok: true, notified });
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
  const auth = await authorizeFormMutation(schoolId, request.nextUrl.searchParams.get('embed_token'));
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
