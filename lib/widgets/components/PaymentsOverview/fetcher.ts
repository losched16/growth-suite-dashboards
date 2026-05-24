// Fetcher for the PaymentsOverview widget. Aggregates payment + invoice
// state into the headline KPIs operators look at every morning:
//   - MTD / YTD collected
//   - Outstanding invoice count + dollar amount
//   - Autopay enrollment rate (families with active autopay vs total)
//   - Recent failed payments
//   - Recent successful payments

import { query } from '@/lib/db';
import type { SchoolContext } from '@/lib/widgets/types';
import type { PaymentsOverviewConfig } from './config';

export interface PaymentsOverviewData {
  mtd_collected_cents: number;
  ytd_collected_cents: number;
  open_invoice_count: number;
  open_invoice_total_cents: number;
  past_due_count: number;
  past_due_total_cents: number;
  autopay_enrolled_families: number;
  total_families_with_open_invoice: number;
  recent_failures: Array<{
    payment_id: string;
    invoice_number: string;
    invoice_id: string;
    family_label: string;
    amount_cents: number;
    failure_message: string | null;
    failed_at: string;
  }>;
  recent_succeeded: Array<{
    payment_id: string;
    invoice_number: string;
    invoice_id: string;
    family_label: string;
    amount_cents: number;
    method_type: string | null;
    succeeded_at: string;
  }>;
}

export async function fetcher(
  school: SchoolContext,
  config: PaymentsOverviewConfig,
): Promise<PaymentsOverviewData> {
  const sid = school.schoolId;
  const failureWindowDays = Math.max(1, Math.min(90, config.failure_window_days ?? 14));
  const recentLimit = Math.max(1, Math.min(50, config.recent_limit ?? 10));

  // KPIs in one round-trip — six aggregations + two list queries.
  const [
    collectedRow,
    openInvoiceRow,
    pastDueRow,
    autopayRow,
    recentFailuresRows,
    recentSucceededRows,
  ] = await Promise.all([
    query<{ mtd: string; ytd: string }>(
      `SELECT
         COALESCE(SUM(p.amount_cents) FILTER (
           WHERE p.created_at >= date_trunc('month', now())), 0)::text AS mtd,
         COALESCE(SUM(p.amount_cents) FILTER (
           WHERE p.created_at >= date_trunc('year', now())), 0)::text AS ytd
       FROM payments p
      WHERE p.school_id = $1 AND p.status = 'succeeded'`,
      [sid],
    ).then((r) => r.rows[0]),

    query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n,
              COALESCE(SUM(total_cents - amount_paid_cents), 0)::text AS total
         FROM invoices
        WHERE school_id = $1
          AND status IN ('open', 'partially_paid')`,
      [sid],
    ).then((r) => r.rows[0]),

    query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n,
              COALESCE(SUM(total_cents - amount_paid_cents), 0)::text AS total
         FROM invoices
        WHERE school_id = $1
          AND status IN ('open', 'partially_paid')
          AND due_at < now()`,
      [sid],
    ).then((r) => r.rows[0]),

    // Autopay enrollment = distinct families with an active payment method
    // attached AND an invoice with autopay_enabled. Denominator: distinct
    // families with an open invoice.
    query<{ enrolled: string; total: string }>(
      `WITH open_fams AS (
         SELECT DISTINCT family_id FROM invoices
          WHERE school_id = $1 AND status IN ('open', 'partially_paid')
       ),
       autopay_fams AS (
         SELECT DISTINCT i.family_id FROM invoices i
          WHERE i.school_id = $1
            AND i.autopay_enabled = true
            AND i.status IN ('open', 'partially_paid')
       )
       SELECT
         (SELECT COUNT(*) FROM autopay_fams)::text AS enrolled,
         (SELECT COUNT(*) FROM open_fams)::text AS total`,
      [sid],
    ).then((r) => r.rows[0]),

    query<{
      payment_id: string;
      invoice_number: string;
      invoice_id: string;
      family_label: string;
      amount_cents: number;
      failure_message: string | null;
      failed_at: string;
    }>(
      `SELECT p.id AS payment_id,
              i.invoice_number,
              i.id AS invoice_id,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', lead.first_name, lead.last_name),
                       '(unnamed family)') AS family_label,
              p.amount_cents,
              p.failure_message,
              p.updated_at AS failed_at
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN families f ON f.id = p.family_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
           WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) lead ON true
        WHERE p.school_id = $1
          AND p.status = 'failed'
          AND p.updated_at >= now() - ($2::text || ' days')::interval
        ORDER BY p.updated_at DESC
        LIMIT $3`,
      [sid, String(failureWindowDays), recentLimit],
    ).then((r) => r.rows),

    query<{
      payment_id: string;
      invoice_number: string;
      invoice_id: string;
      family_label: string;
      amount_cents: number;
      method_type: string | null;
      succeeded_at: string;
    }>(
      `SELECT p.id AS payment_id,
              i.invoice_number,
              i.id AS invoice_id,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', lead.first_name, lead.last_name),
                       '(unnamed family)') AS family_label,
              p.amount_cents,
              p.stripe_payment_method_type AS method_type,
              p.updated_at AS succeeded_at
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN families f ON f.id = p.family_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name FROM parents
           WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) lead ON true
        WHERE p.school_id = $1
          AND p.status = 'succeeded'
        ORDER BY p.updated_at DESC
        LIMIT $2`,
      [sid, recentLimit],
    ).then((r) => r.rows),
  ]);

  return {
    mtd_collected_cents: Number(collectedRow?.mtd ?? 0),
    ytd_collected_cents: Number(collectedRow?.ytd ?? 0),
    open_invoice_count: Number(openInvoiceRow?.n ?? 0),
    open_invoice_total_cents: Number(openInvoiceRow?.total ?? 0),
    past_due_count: Number(pastDueRow?.n ?? 0),
    past_due_total_cents: Number(pastDueRow?.total ?? 0),
    autopay_enrolled_families: Number(autopayRow?.enrolled ?? 0),
    total_families_with_open_invoice: Number(autopayRow?.total ?? 0),
    recent_failures: recentFailuresRows,
    recent_succeeded: recentSucceededRows,
  };
}
