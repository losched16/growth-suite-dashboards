// /school/[locationId]/staff-requests/mine
//
// Teacher-facing view: every request THIS TEACHER submitted, with
// current status + scheduled date + Lexi's notes (read-only). Filtered
// by submitter_email = the school session's user_email.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ArrowLeft, CheckCircle2, Clock, CalendarCheck, XCircle, AlertCircle, Plus } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ submitted?: string }>;

interface SubmissionRow {
  id: string;
  display_name: string;
  slug: string;
  submitted_at: Date | string;
  resolved_status: string;
  scheduled_date: string | null;
  admin_notes: string | null;
  assigned_to_email: string | null;
}

export default async function MyStaffRequestsPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound(); // proxy auto-mints; if it failed somehow we'd 404

  const { rows } = await query<SubmissionRow>(
    `SELECT s.id, d.display_name, d.slug, s.submitted_at, s.resolved_status,
            s.scheduled_date, s.admin_notes, s.assigned_to_email
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1 AND s.submitter_email = $2
      ORDER BY s.submitted_at DESC
      LIMIT 100`,
    [session.school_id, session.user_email],
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <Link href={`/school/${locationId}/staff-requests?chrome=none`}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-3">
          <ArrowLeft className="h-3 w-3" /> Submit a new request
        </Link>

        <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">My recent requests</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Requests submitted by <span className="font-mono">{session.user_email}</span>. Status updates auto-refresh.
            </p>
          </div>
          <Link
            href={`/school/${locationId}/staff-requests?chrome=none`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> Submit a new request
          </Link>
        </div>

        {sp.submitted ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 mb-3">
            ✓ Your <strong>{sp.submitted.replace(/-/g, ' ')}</strong> was submitted. Lexi has been notified.
          </div>
        ) : null}

        {rows.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="text-sm text-slate-700 font-medium">No requests yet</p>
            <p className="mt-1 text-xs text-slate-500">
              Submit a Labor Request, Incident Report, or Supply Request to get started.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Submitted</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Scheduled date</th>
                  <th className="px-3 py-2 font-medium">Lexi&rsquo;s notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-2.5 font-medium text-slate-900">{r.display_name}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                      {fmtDate(r.submitted_at)}
                    </td>
                    <td className="px-3 py-2.5"><StatusPill status={r.resolved_status} /></td>
                    <td className="px-3 py-2.5 text-sm">
                      {r.scheduled_date
                        ? <span className="text-blue-700 font-semibold">{fmtDateOnly(r.scheduled_date)}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-pre-wrap">
                      {r.admin_notes || <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function fmtDate(s: string | Date): string {
  const d = typeof s === 'string' ? new Date(s) : s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtDateOnly(s: string): string {
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
