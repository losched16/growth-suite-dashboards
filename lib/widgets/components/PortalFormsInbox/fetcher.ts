// Data fetcher for PortalFormsInbox — newest portal-form submissions
// for this school. Joins to families/students/parents for labels and
// to portal_form_definitions for the form name + category.

import { query } from '@/lib/db';
import type { SchoolContext } from '@/lib/widgets/types';
import type { PortalFormsInboxConfig } from './config';

export interface InboxRow {
  id: string;
  form_definition_id: string;
  form_slug: string;
  form_name: string;
  category: string | null;
  family_id: string | null;
  family_label: string;
  parent_name: string;
  parent_email: string | null;
  student_name: string | null;
  status: string;
  submitted_at: string;
  fee_amount_charged: string | null;
  payment_status: string | null;
  ghl_synced_at: string | null;
  ghl_sync_error: string | null;
  needs_review: boolean;
  // When a form has a payment_config, a submission spawns an invoice.
  // We expose its number/status/total so the operator can jump to the
  // invoice record without opening a separate tool.
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  invoice_total_cents: number | null;
  // Form addendum metadata. If is_addendum=true, this row is a partial
  // update of parent_submission_id, touching only the listed fields.
  is_addendum: boolean;
  parent_submission_id: string | null;
  addendum_fields: string[] | null;
}

export interface PortalFormsInboxData {
  rows: InboxRow[];
  total_count: number;
  pending_review_count: number;
  pending_payment_count: number;
}

export async function fetcher(
  school: SchoolContext,
  config: PortalFormsInboxConfig,
): Promise<PortalFormsInboxData> {
  const limit = Math.max(1, Math.min(200, config.limit ?? 25));

  const statusClause = config.status_filter === 'all'
    ? `('submitted', 'paid', 'pending_payment', 'voided')`
    : `('${config.status_filter.replace(/'/g, '')}')`; // narrow allow-list

  const catFilter = (config.category_filter ?? '').trim().toLowerCase();
  const enrolledTag = (config.enrolled_tag ?? '').trim().toLowerCase();
  const excludedTag = (config.excluded_tag ?? '').trim().toLowerCase();

  // Build optional tag-filter clauses + positional param indexes.
  // Params are: $1=school, $2=year, $3=catFilter, $4=limit; then
  // $5/$6 used by the optional tag clauses below.
  const params: unknown[] = [school.schoolId, config.academic_year, catFilter, limit];
  let enrolledTagIdx: number | null = null;
  let excludedTagIdx: number | null = null;
  if (enrolledTag) { params.push(enrolledTag); enrolledTagIdx = params.length; }
  if (excludedTag) { params.push(excludedTag); excludedTagIdx = params.length; }

  const tagInclude = enrolledTagIdx !== null
    ? `AND EXISTS (
         SELECT 1 FROM parents pt
           JOIN ghl_contact_tags t ON t.ghl_contact_id = pt.ghl_contact_id AND t.school_id = s.school_id
          WHERE pt.family_id = f.id AND pt.status = 'active'
            AND lower(t.tag) = $${enrolledTagIdx}
       )`
    : '';
  const tagExclude = excludedTagIdx !== null
    ? `AND NOT EXISTS (
         SELECT 1 FROM parents pt
           JOIN ghl_contact_tags t ON t.ghl_contact_id = pt.ghl_contact_id AND t.school_id = s.school_id
          WHERE pt.family_id = f.id AND pt.status = 'active'
            AND lower(t.tag) = $${excludedTagIdx}
       )`
    : '';

  const rowsRes = await query<InboxRow & { def_needs_review: boolean }>(
    `SELECT
       s.id,
       s.form_definition_id,
       d.slug AS form_slug,
       d.display_name AS form_name,
       d.category,
       d.needs_review AS def_needs_review,
       f.id AS family_id,
       COALESCE(NULLIF(f.display_name, ''),
                NULLIF(CONCAT_WS(' ', p_lead.first_name, p_lead.last_name), ''),
                -- Family/parent rows gone (contact deleted in GHL after
                -- submitting) → fall back to what the submission preserved:
                -- the signer's name from the responses, then the submitter
                -- email stamped before the link was severed.
                NULLIF(CONCAT_WS(' ', s.responses->>'pg1_first_name', s.responses->>'pg1_last_name'), ''),
                s.submitter_email,
                '(unnamed family)') AS family_label,
       NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS parent_name,
       COALESCE(p.email, s.submitter_email) AS parent_email,
       CASE WHEN st.id IS NOT NULL
            THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
            ELSE NULL END AS student_name,
       s.status,
       s.submitted_at,
       s.fee_amount_charged,
       s.payment_status,
       s.ghl_synced_at,
       s.ghl_sync_error,
       s.created_at,
       false AS needs_review,
       inv.id AS invoice_id,
       inv.invoice_number AS invoice_number,
       inv.status AS invoice_status,
       inv.total_cents AS invoice_total_cents,
       s.is_addendum,
       s.parent_submission_id,
       s.addendum_fields
     FROM portal_form_submissions s
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     JOIN families f ON f.id = s.family_id
     LEFT JOIN parents p ON p.id = s.parent_id
     LEFT JOIN students st ON st.id = s.student_id
     LEFT JOIN invoices inv ON inv.id = s.invoice_id
     LEFT JOIN LATERAL (
       SELECT first_name, last_name FROM parents
       WHERE family_id = f.id AND is_primary = true LIMIT 1
     ) p_lead ON true
     WHERE s.school_id = $1
       AND s.academic_year = $2
       AND s.status IN ${statusClause}
       AND ($3 = '' OR LOWER(d.category) = $3)
       ${tagInclude}
       ${tagExclude}
     ORDER BY s.submitted_at DESC
     LIMIT $4`,
    params,
  );

  const rows: InboxRow[] = rowsRes.rows.map((r) => ({
    ...r,
    needs_review: r.def_needs_review,
  }));

  // Totals (separate counts so the widget header is informative).
  const totalsRes = await query<{
    total: string;
    pending_review: string;
    pending_payment: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE s.status IN ('submitted', 'paid', 'pending_payment', 'voided')) AS total,
       COUNT(*) FILTER (WHERE d.needs_review = true AND s.status IN ('submitted', 'paid')) AS pending_review,
       COUNT(*) FILTER (WHERE s.status = 'pending_payment') AS pending_payment
     FROM portal_form_submissions s
     JOIN portal_form_definitions d ON d.id = s.form_definition_id
     WHERE s.school_id = $1 AND s.academic_year = $2`,
    [school.schoolId, config.academic_year],
  );
  const totals = totalsRes.rows[0] ?? { total: '0', pending_review: '0', pending_payment: '0' };

  return {
    rows,
    total_count: Number(totals.total),
    pending_review_count: Number(totals.pending_review),
    pending_payment_count: Number(totals.pending_payment),
  };
}
