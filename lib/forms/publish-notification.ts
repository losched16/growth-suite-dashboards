// Explicit "tell the families" fan-out for a portal form: in-portal
// notification (bell + inbox) to exactly the families the form targets,
// plus a CRM email per parent. Extracted from the forms PATCH route when
// publishing was decoupled from notifying (Clint, Aug 6: "I want to be
// able to test forms without publishing to everyone... I don't want a
// notification going to everyone until they are ready").
//
// Called ONLY from the explicit notify endpoint the builder's
// "Send notification" button hits — never automatically on publish.

import { after } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { resolveRecipients, sanitizeAudience, summarizeAudience } from '@/lib/notifications/audience';

// Map a form's applies_to rule to a notification audience. The rule
// types the builder's "Who sees this form" UI produces (program,
// grade_level, tag) translate 1:1; OR semantics on both sides. Rules
// this can't express (student_ids, tuition_grid, other metadata keys)
// fall back to "everyone" only when there is NO rule at all.
export function audienceForAppliesTo(appliesTo: unknown): unknown | null {
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

export async function sendFormNotification(
  schoolId: string,
  formId: string,
  opts: { createdBy: string; dedupeMinutes?: number },
): Promise<{ ok: true; notified: number } | { ok: false; reason: string }> {
  const { rows: defRows } = await query<{ display_name: string; slug: string; applies_to: unknown; is_active: boolean }>(
    `SELECT display_name, slug, applies_to, is_active FROM portal_form_definitions
      WHERE id = $1 AND school_id = $2`,
    [formId, schoolId],
  );
  const def = defRows[0];
  if (!def) return { ok: false, reason: 'form_not_found' };
  if (!def.is_active) return { ok: false, reason: 'form_not_published' };

  const title = `New form: ${def.display_name}`;

  // Double-click / accidental-resend guard. Short window only — an
  // EXPLICIT send after fixing targeting should go out.
  const dedupeMin = opts.dedupeMinutes ?? 10;
  const { rows: dup } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM portal_notifications
      WHERE school_id = $1 AND title = $2 AND created_at > now() - ($3::text || ' minutes')::interval`,
    [schoolId, title, String(dedupeMin)],
  );
  if (Number(dup[0].n) > 0) return { ok: false, reason: 'recently_sent' };

  const audience = sanitizeAudience(audienceForAppliesTo(def.applies_to));
  if (!audience) return { ok: false, reason: 'audience_unresolvable' };
  const recipients = await resolveRecipients(schoolId, audience);
  if (recipients.length === 0) return { ok: false, reason: 'no_recipients' };

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
       JSON.stringify(audience), summarizeAudience(audience), recipients.length, opts.createdBy],
    );
    await q(
      `INSERT INTO portal_notification_recipients (notification_id, school_id, parent_id, family_id)
       SELECT $1, $2, pid, fid FROM unnest($3::uuid[], $4::uuid[]) AS t(pid, fid)
       ON CONFLICT (notification_id, parent_id) DO NOTHING`,
      [rows[0].id, schoolId, recipients.map((r) => r.parent_id), recipients.map((r) => r.family_id)],
    );
  });

  // EMAIL each recipient too — parents need a heads-up to even open the
  // portal. Sent through the school's CRM so every email lands in the
  // contact's conversation history. Runs via after() so the click
  // returns immediately while the fan-out completes.
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
          console.error(`[form-notify] email to contact ${p.ghl_contact_id} failed:`,
            e instanceof Error ? e.message : String(e));
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      console.log(`[form-notify] "${def.display_name}": emailed ${sent}, failed ${failed}`);
    } catch (e) {
      console.error('[form-notify] email fan-out failed:', e);
    }
  });

  return { ok: true, notified: recipients.length };
}
