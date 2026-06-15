import type { WidgetDefinition } from '@/lib/widgets/types';
import {
  portalFormsInboxDefaults,
  portalFormsInboxSchema,
  type PortalFormsInboxConfig,
} from './config';
import { fetcher, type PortalFormsInboxData, type InboxRow } from './fetcher';

function fmtDateTime(s: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function StatusPill({ status, payment }: { status: string; payment: string | null }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    submitted: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Submitted' },
    paid: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Paid' },
    pending_payment: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending payment' },
    voided: { bg: 'bg-red-100', text: 'text-red-800', label: 'Voided' },
  };
  const cfg = map[status] ?? { bg: 'bg-gray-100', text: 'text-gray-700', label: status };
  return (
    <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cfg.text}`}>
      {cfg.label}{payment && payment !== 'paid' && status !== 'voided' ? ` · ${payment}` : ''}
    </span>
  );
}

function GhlSyncBadge({ syncedAt, error }: { syncedAt: string | null; error: string | null }) {
  // Differentiate "partial sync" (some fields skipped because they don't
  // exist in the GHL location yet — typically per-student fields for a
  // family with fewer kids than the template assumes) from a real error
  // (HTTP failure / auth / network). Wooster's "GHL: error" panic on
  // Rachel's Enrollment Agreement was actually just one skipped key.
  const isPartial = !!error && !!syncedAt && /^skipped keys:/i.test(error.trim());
  if (error && !isPartial) {
    return <span className="text-[10px] text-red-700" title={error}>GHL: error</span>;
  }
  if (isPartial) {
    return (
      <span
        className="text-[10px] text-amber-700"
        title={`${error} (writeback completed; these fields are not configured in your GHL location yet)`}
      >
        GHL: partial
      </span>
    );
  }
  if (syncedAt) {
    return <span className="text-[10px] text-emerald-700">GHL: synced</span>;
  }
  return <span className="text-[10px] text-gray-400">GHL: pending</span>;
}

function PortalFormsInboxComponent({ data, school }: { data: PortalFormsInboxData; school: { locationId: string } }) {
  if (data.rows.length === 0 && data.total_count === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No portal form submissions yet for this year.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Portal forms inbox</h3>
        <div className="text-xs text-gray-500">
          {data.rows.length} of {data.total_count} this year
          {data.pending_payment_count > 0 ? ` · ${data.pending_payment_count} pending payment` : ''}
        </div>
      </div>
      <ul className="divide-y divide-gray-100">
        {data.rows.map((r) => <Row key={r.id} r={r} locationId={school.locationId} />)}
      </ul>
    </div>
  );
}

function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  return `$${(cents / 100).toFixed(2)}`;
}

function Row({ r, locationId }: { r: InboxRow; locationId: string }) {
  return (
    <li className="px-4 py-2.5 flex flex-wrap items-start gap-x-4 gap-y-1">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-gray-900 truncate">
            {r.form_name}
          </span>
          <StatusPill status={r.status} payment={r.payment_status} />
          {r.category ? (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
              {r.category}
            </span>
          ) : null}
          {r.is_addendum ? (
            <span
              className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800 border border-violet-200"
              title={
                r.addendum_fields && r.addendum_fields.length > 0
                  ? `Partial update of an earlier submission. Fields updated: ${r.addendum_fields.join(', ')}`
                  : 'Partial update of an earlier submission'
              }
            >
              ✎ Addendum
              {r.addendum_fields ? ` (${r.addendum_fields.length})` : ''}
            </span>
          ) : null}
          {r.invoice_id ? (
            <span
              className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-mono text-blue-800 border border-blue-100"
              title={`Invoice status: ${r.invoice_status ?? 'unknown'} · ${fmtCents(r.invoice_total_cents)}`}
            >
              {r.invoice_number ?? 'invoice'}
              {r.invoice_total_cents != null ? ` · ${fmtCents(r.invoice_total_cents)}` : ''}
            </span>
          ) : null}
        </div>
        <div className="text-xs text-gray-600 truncate">
          {r.family_id ? (
            <a
              href={`/school/${locationId}/families/${r.family_id}/forms?chrome=none`}
              className="text-emerald-700 hover:underline"
              title="View all forms this family has submitted"
            >
              {r.family_label}
            </a>
          ) : (
            <span>{r.family_label}</span>
          )}
          {r.student_name ? ` · ${r.student_name}` : ''}
          {' · by '}
          {r.parent_name}
          {r.parent_email ? ` (${r.parent_email})` : ''}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <div className="text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(r.submitted_at)}</div>
        <GhlSyncBadge syncedAt={r.ghl_synced_at} error={r.ghl_sync_error} />
      </div>
    </li>
  );
}

export const PortalFormsInbox: WidgetDefinition<PortalFormsInboxConfig, PortalFormsInboxData> = {
  id: 'portal_forms_inbox',
  display_name: 'Portal Forms Inbox',
  description: 'Recent portal-form submissions from parents — newest first.',
  category: 'documents',
  default_config: portalFormsInboxDefaults,
  config_schema: portalFormsInboxSchema,
  default_size: { w: 12, h: 6 },
  Component: PortalFormsInboxComponent,
  dataFetcher: fetcher,
};
