// /school/[locationId]/staff-requests/inbox
//
// Lexi-facing inbox. Shows the queue of staff submissions (Labor,
// Incident, Supplies) with inline forms to acknowledge, schedule,
// complete, reject, reassign, or add notes. Status defaults to
// "pending" filter — toggle to see all.
//
// Auth: any valid school session can open the page for now (the
// dashboard is added to the school's enabled dashboards by an
// operator; only Lexi-equivalent staff get the link in their nav).
// Tighten later if needed.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Inbox, CheckCircle2, Clock, CalendarCheck, XCircle, AlertCircle, Filter, Wrench, Package, CalendarDays } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ status?: string; slug?: string; msg?: string; err?: string; open?: string }>;

interface RowSnapshot {
  id: string;
  display_name: string;
  slug: string;
  category: string | null;
  submitted_at: Date | string;
  resolved_status: string;
  submitter_email: string;
  assigned_to_email: string | null;
  scheduled_date: string | null;
  admin_notes: string | null;
  responses: Record<string, unknown>;
  acknowledged_at: Date | string | null;
  scheduled_at: Date | string | null;
  completed_at: Date | string | null;
}

interface FormCount {
  slug: string;
  display_name: string;
  pending_count: number;
}

const STATUS_OPTIONS = ['pending', 'acknowledged', 'scheduled', 'completed', 'rejected', 'all'] as const;

export default async function StaffRequestsInboxPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const statusFilter = (STATUS_OPTIONS as readonly string[]).includes(sp.status ?? '') ? sp.status! : 'pending';
  const slugFilter = sp.slug ?? '';
  const openId = sp.open ?? null;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Pending counts per form (badges on the form filter)
  const { rows: countsRaw } = await query<FormCount>(
    `SELECT d.slug, d.display_name,
            COUNT(s.id) FILTER (WHERE s.resolved_status='pending') AS pending_count
       FROM portal_form_definitions d
       LEFT JOIN portal_form_submissions s
         ON s.form_definition_id = d.id
        AND s.submitter_email IS NOT NULL
      WHERE d.school_id = $1 AND d.audience='staff' AND d.is_active = true
      GROUP BY d.slug, d.display_name
      ORDER BY d.display_name`,
    [school.id],
  );
  const counts = countsRaw.map((c) => ({ ...c, pending_count: Number(c.pending_count) }));

  // Queue rows for the active filter
  const { rows } = await query<RowSnapshot>(
    `SELECT s.id, d.display_name, d.slug, d.category,
            s.submitted_at, s.resolved_status, s.submitter_email,
            s.assigned_to_email, s.scheduled_date, s.admin_notes, s.responses,
            s.acknowledged_at, s.scheduled_at, s.completed_at
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1
        AND d.audience='staff'
        AND s.submitter_email IS NOT NULL
        AND ($2 = 'all' OR s.resolved_status = $2)
        AND ($3 = '' OR d.slug = $3)
      ORDER BY s.submitted_at DESC
      LIMIT 200`,
    [school.id, statusFilter, slugFilter],
  );

  const baseUrl = `/school/${locationId}/staff-requests/inbox?chrome=none`;
  const linkFor = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ chrome: 'none', status: statusFilter });
    if (slugFilter) p.set('slug', slugFilter);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/school/${locationId}/staff-requests/inbox?${p.toString()}`;
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <Inbox className="h-6 w-6 text-blue-600" /> Staff requests inbox
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">Labor, Incident, and Supplies requests submitted by teachers.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/school/${locationId}/staff-requests/calendar?chrome=none&mode=all`}
              className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 text-blue-700 px-3 py-1.5 text-xs font-semibold hover:bg-blue-100">
              <CalendarDays className="h-3.5 w-3.5" /> Calendar view
            </Link>
            <Link href={`/school/${locationId}/staff-requests?chrome=none`}
              className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" /> View as a teacher
            </Link>
          </div>
        </div>

        {sp.msg ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 mb-3">{sp.msg}</div>
        ) : null}
        {sp.err ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 mb-3">{sp.err}</div>
        ) : null}

        {/* Filter row */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Filter className="h-4 w-4 text-slate-400" />
          {STATUS_OPTIONS.map((s) => (
            <Link key={s}
              href={`${baseUrl}&status=${s}${slugFilter ? `&slug=${slugFilter}` : ''}`}
              className={statusFilter === s
                ? 'rounded-full bg-blue-600 text-white px-3 py-1 text-xs font-semibold capitalize'
                : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 capitalize'}>
              {s}
            </Link>
          ))}
          <span className="text-slate-300">|</span>
          <Link href={`${baseUrl}&status=${statusFilter}`}
            className={!slugFilter
              ? 'rounded-full bg-slate-800 text-white px-3 py-1 text-xs font-semibold'
              : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50'}>
            All forms
          </Link>
          {counts.map((c) => (
            <Link key={c.slug}
              href={`${baseUrl}&status=${statusFilter}&slug=${c.slug}`}
              className={slugFilter === c.slug
                ? 'rounded-full bg-slate-800 text-white px-3 py-1 text-xs font-semibold inline-flex items-center gap-1'
                : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1'}>
              {c.display_name}
              {c.pending_count > 0 ? (
                <span className="rounded-full bg-amber-500 text-white px-1.5 py-0.5 text-[10px] font-bold leading-none">
                  {c.pending_count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm text-slate-700 font-medium">No requests in this view</p>
            <p className="mt-1 text-xs text-slate-500">Try a different status filter or wait for teachers to submit.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const isOpen = openId === r.id;
              return (
                <li key={r.id} className="rounded-lg border border-slate-200 bg-white">
                  <Link href={linkFor({ open: isOpen ? '' : r.id })}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
                    <FormIcon slug={r.slug} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold text-slate-900">{r.display_name}</span>
                        <StatusPill status={r.resolved_status} />
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {fmtDate(r.submitted_at)} · from <span className="font-mono">{r.submitter_email}</span>
                        {r.scheduled_date ? <> · scheduled <strong>{fmtDateOnly(r.scheduled_date)}</strong></> : null}
                      </div>
                    </div>
                  </Link>

                  {isOpen ? (
                    <div className="border-t border-slate-200 px-4 py-4 bg-slate-50/50 space-y-4">
                      {/* Responses */}
                      <div>
                        <h3 className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-2">Submission detail</h3>
                        <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                          {Object.entries(r.responses).filter(([k]) => !k.startsWith('__')).map(([k, v]) => (
                            <ResponseRow key={k} k={k} v={v} />
                          ))}
                        </dl>
                      </div>

                      {/* Actions */}
                      <div className="border-t border-slate-200 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {/* Schedule */}
                        <form action={`/api/school/staff-requests/${r.id}/action`} method="POST" className="rounded-md border border-blue-200 bg-blue-50/40 p-3">
                          <input type="hidden" name="action" value="schedule" />
                          <input type="hidden" name="return_to" value={linkFor({})} />
                          <label className="text-[11px] uppercase tracking-wide text-blue-900 font-semibold">Schedule</label>
                          <input type="date" name="scheduled_date"
                            defaultValue={r.scheduled_date ?? ''}
                            required className="mt-1 block w-full rounded border border-blue-200 px-2 py-1 text-sm" />
                          <button type="submit" className="mt-2 w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                            Set scheduled date
                          </button>
                        </form>

                        {/* Notes */}
                        <form action={`/api/school/staff-requests/${r.id}/action`} method="POST" className="rounded-md border border-slate-200 bg-white p-3">
                          <input type="hidden" name="action" value="update_notes" />
                          <input type="hidden" name="return_to" value={linkFor({})} />
                          <label className="text-[11px] uppercase tracking-wide text-slate-600 font-semibold">Notes (visible to teacher)</label>
                          <textarea name="admin_notes" rows={2}
                            defaultValue={r.admin_notes ?? ''}
                            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                          <button type="submit" className="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                            Save notes
                          </button>
                        </form>
                      </div>

                      {/* Status quick-actions */}
                      <div className="border-t border-slate-200 pt-3 flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">Quick status</span>
                        {(['acknowledge', 'complete', 'reject'] as const).map((act) => (
                          <form key={act} action={`/api/school/staff-requests/${r.id}/action`} method="POST">
                            <input type="hidden" name="action" value={act} />
                            <input type="hidden" name="return_to" value={linkFor({})} />
                            <button type="submit" className={
                              act === 'complete' ? 'rounded-md bg-emerald-600 text-white px-3 py-1 text-xs font-semibold hover:bg-emerald-700' :
                              act === 'reject' ? 'rounded-md border border-rose-300 bg-white text-rose-700 px-3 py-1 text-xs font-medium hover:bg-rose-50' :
                              'rounded-md border border-slate-300 bg-white text-slate-700 px-3 py-1 text-xs font-medium hover:bg-slate-50'
                            }>
                              {act.charAt(0).toUpperCase() + act.slice(1)}
                            </button>
                          </form>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}

function FormIcon({ slug }: { slug: string }) {
  if (slug.includes('labor')) return <Wrench className="h-5 w-5 text-blue-600 mt-1 shrink-0" />;
  if (slug.includes('incident')) return <AlertCircle className="h-5 w-5 text-rose-600 mt-1 shrink-0" />;
  if (slug.includes('supply')) return <Package className="h-5 w-5 text-amber-600 mt-1 shrink-0" />;
  return <Inbox className="h-5 w-5 text-slate-500 mt-1 shrink-0" />;
}

function ResponseRow({ k, v }: { k: string; v: unknown }) {
  // student_picker: render as a contact card with parents + click-to-call
  // / click-to-email links. Marked with _type so we recognize it
  // regardless of what key the schema used.
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>)._type === 'student_picker') {
    const card = v as { full_name?: string; name?: string; homeroom?: string | null; parents?: Array<{ name: string; email: string | null; phone: string | null; role: string | null; is_primary: boolean }> };
    const parents = card.parents ?? [];
    return (
      <>
        <dt className="font-mono text-slate-600 break-all">{k}</dt>
        <dd>
          <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-2 space-y-1.5">
            <div className="text-sm font-semibold text-slate-900">
              {card.full_name ?? card.name ?? 'Student'}
              {card.homeroom ? <span className="ml-2 text-[11px] font-normal text-slate-500">({card.homeroom})</span> : null}
            </div>
            {parents.length === 0 ? (
              <div className="text-[11px] italic text-slate-500">No parent contacts on file.</div>
            ) : (
              <ul className="space-y-1">
                {parents.map((p, idx) => (
                  <li key={idx} className="rounded border border-emerald-100 bg-white px-2 py-1.5 text-xs">
                    <div className="font-medium text-slate-900">
                      {p.name}
                      {p.is_primary ? <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0 text-[9px] font-bold uppercase text-emerald-800">primary</span> : null}
                      {p.role ? <span className="ml-1.5 text-[10px] font-normal text-slate-500">({p.role})</span> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      {p.email ? <a href={`mailto:${p.email}`} className="text-blue-600 hover:underline">{p.email}</a> : null}
                      {p.phone ? <a href={`tel:${p.phone}`} className="text-blue-600 hover:underline">{p.phone}</a> : null}
                      {!p.email && !p.phone ? <span className="text-slate-400 italic">no contact info on file</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </dd>
      </>
    );
  }
  // Grid responses serialize as plain objects { item_label: quantity }
  // — render as a clean per-item list with quantity badges so Lexi can
  // pull supplies without re-counting from raw JSON.
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <>
          <dt className="font-mono text-slate-600 break-all">{k}</dt>
          <dd className="text-slate-400 italic">(none requested)</dd>
        </>
      );
    }
    return (
      <>
        <dt className="font-mono text-slate-600 break-all">{k}</dt>
        <dd>
          <ul className="space-y-0.5">
            {entries.map(([item, qty]) => (
              <li key={item} className="flex items-baseline gap-2">
                <span className="inline-block min-w-[1.75rem] rounded bg-blue-100 text-blue-800 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-center">
                  {String(qty)}
                </span>
                <span className="text-slate-800">{item}</span>
              </li>
            ))}
          </ul>
        </dd>
      </>
    );
  }
  let display: string;
  if (v == null) display = '(empty)';
  else if (Array.isArray(v)) display = v.length === 0 ? '(none)' : v.map(String).join(', ');
  else if (typeof v === 'boolean') display = v ? 'yes' : 'no';
  else display = String(v);
  return (
    <>
      <dt className="font-mono text-slate-600 break-all">{k}</dt>
      <dd className="text-slate-900 break-words whitespace-pre-wrap">{display}</dd>
    </>
  );
}

function fmtDate(s: string | Date): string {
  const d = typeof s === 'string' ? new Date(s) : s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDateOnly(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function StatusPill({ status }: { status: string }) {
  const cfg = {
    pending:      { bg: 'bg-amber-100',  fg: 'text-amber-800',   Icon: Clock,         label: 'Pending' },
    acknowledged: { bg: 'bg-blue-100',   fg: 'text-blue-800',    Icon: AlertCircle,   label: 'Acknowledged' },
    scheduled:    { bg: 'bg-violet-100', fg: 'text-violet-800',  Icon: CalendarCheck, label: 'Scheduled' },
    completed:    { bg: 'bg-emerald-100',fg: 'text-emerald-800', Icon: CheckCircle2,  label: 'Completed' },
    rejected:     { bg: 'bg-rose-100',   fg: 'text-rose-800',    Icon: XCircle,       label: 'Rejected' },
  }[status] ?? { bg: 'bg-slate-100', fg: 'text-slate-600', Icon: Clock, label: status };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      <cfg.Icon className="h-3 w-3" /> {cfg.label}
    </span>
  );
}
