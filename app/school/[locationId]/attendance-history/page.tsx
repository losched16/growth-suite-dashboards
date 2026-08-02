// /school/[locationId]/attendance-history?student=<id>
//
// Per-student attendance history: every check-in / check-out / absence
// over a chosen range (2 weeks, month, 3 months, year, or custom
// dates), with who performed it, kiosk vs portal vs admin source,
// curbside + notes, and a link to VIEW THE SIGNATURE captured on each
// event. CSV export of the same range.
//
// Reached from the roster's Attendance column ("history" link), which
// carries the embed params — so it works inside the GHL iframe (embed
// token) and for direct school-session visits alike.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { CalendarRange, Download, LogIn, LogOut, UserX } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TZ = 'America/Phoenix'; // same MVP posture as the attendance dashboard

interface EventRow {
  id: string;
  event_type: string;
  performed_at: string;
  performed_by_name_snapshot: string | null;
  performed_by_admin_email: string | null;
  picked_up_by_name_snapshot: string | null;
  source: string | null;
  curbside: boolean;
  curbside_slot: string | null;
  pickup_time: string | null;
  notes: string | null;
  has_signature: boolean;
}

const RANGES: Array<{ key: string; label: string; days: number }> = [
  { key: '2w', label: 'Last 2 weeks', days: 14 },
  { key: '1m', label: 'Last month', days: 31 },
  { key: '3m', label: 'Last 3 months', days: 92 },
  { key: '1y', label: 'Last year', days: 366 },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function AttendanceHistoryPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? (sp[k] as string[])[0] : sp[k] as string | undefined);

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Auth: school session for this school OR a valid embed token.
  const embedToken = one('embed_token');
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const sessionOk = !!session && session.ghl_location_id === locationId;
  const embedOk = !!embedToken && checkEmbedToken(locationId, embedToken);
  if (!sessionOk && !embedOk) notFound();

  const studentId = one('student') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(studentId)) notFound();

  const { rows: sRows } = await query<{ id: string; name: string; homeroom: string | null; family: string | null }>(
    `SELECT st.id,
            CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name) AS name,
            st.metadata->>'homeroom' AS homeroom,
            f.display_name AS family
       FROM students st JOIN families f ON f.id = st.family_id
      WHERE st.id = $1 AND st.school_id = $2`,
    [studentId, school.id],
  );
  const student = sRows[0];
  if (!student) notFound();

  // Range: custom from/to wins; otherwise a preset (default: last month).
  const customFrom = one('from'); const customTo = one('to');
  const custom = isDate(customFrom) && isDate(customTo);
  const rangeKey = custom ? 'custom' : (RANGES.find((r) => r.key === one('range'))?.key ?? '1m');
  const from = custom ? customFrom! : isoDaysAgo(RANGES.find((r) => r.key === rangeKey)!.days);
  const to = custom ? customTo! : new Date().toISOString().slice(0, 10);

  const { rows: events } = await query<EventRow>(
    `SELECT id, event_type, performed_at,
            performed_by_name_snapshot, performed_by_admin_email,
            picked_up_by_name_snapshot, source, curbside, curbside_slot,
            pickup_time, notes,
            signature_png IS NOT NULL AND signature_png <> '' AS has_signature
       FROM attendance_events
      WHERE student_id = $1 AND school_id = $2
        AND performed_at >= ($3::date::timestamptz)
        AND performed_at < (($4::date + 1)::timestamptz)
      ORDER BY performed_at DESC
      LIMIT 2000`,
    [studentId, school.id, from, to],
  );

  const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

  const checkIns = events.filter((e) => e.event_type === 'check_in');
  const daysPresent = new Set(checkIns.map((e) => new Date(e.performed_at).toLocaleDateString('en-CA', { timeZone: TZ }))).size;
  const absences = events.filter((e) => e.event_type === 'absent').length;
  const withSig = events.filter((e) => e.has_signature).length;

  // Every internal link keeps the embed auth params.
  const keep = new URLSearchParams({ student: studentId });
  if (embedToken) keep.set('embed_token', embedToken);
  if (one('chrome')) keep.set('chrome', one('chrome')!);
  const hrefFor = (extra: Record<string, string>) => {
    const q = new URLSearchParams(keep);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return `/school/${locationId}/attendance-history?${q.toString()}`;
  };
  const csvQ = new URLSearchParams({ student: studentId, from, to });
  if (embedToken) csvQ.set('embed_token', embedToken);
  const sigQ = embedToken ? `?embed_token=${encodeURIComponent(embedToken)}` : '';

  return (
    <main className="min-h-screen bg-slate-50 print:bg-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{student.name}</h1>
            <p className="text-sm text-slate-600">
              Attendance history{student.homeroom ? <> · {student.homeroom}</> : null}{student.family ? <> · {student.family}</> : null}
            </p>
          </div>
          <a
            href={`/api/export/attendance-history/${encodeURIComponent(locationId)}?${csvQ.toString()}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 print:hidden"
          >
            <Download className="h-4 w-4" /> Download CSV
          </a>
        </div>

        {/* Range switcher */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5 print:hidden">
          {RANGES.map((r) => (
            <a
              key={r.key}
              href={hrefFor({ range: r.key })}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                rangeKey === r.key ? 'bg-slate-800 text-white' : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {r.label}
            </a>
          ))}
          <form method="GET" className="ml-2 flex items-center gap-1.5">
            <input type="hidden" name="student" value={studentId} />
            {embedToken ? <input type="hidden" name="embed_token" value={embedToken} /> : null}
            {one('chrome') ? <input type="hidden" name="chrome" value={one('chrome')} /> : null}
            <CalendarRange className="h-4 w-4 text-slate-400" />
            <input type="date" name="from" defaultValue={from} className="rounded border border-slate-300 px-2 py-1 text-xs" />
            <span className="text-xs text-slate-500">to</span>
            <input type="date" name="to" defaultValue={to} className="rounded border border-slate-300 px-2 py-1 text-xs" />
            <button type="submit" className="rounded bg-slate-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800">Go</button>
          </form>
        </div>

        {/* Summary */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ['Days present', String(daysPresent)],
            ['Check-ins', String(checkIns.length)],
            ['Absences recorded', String(absences)],
            ['Events with signature', `${withSig}/${events.length}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
              <div className="text-lg font-bold text-slate-900 tabular-nums">{value}</div>
            </div>
          ))}
        </div>

        <p className="mt-2 text-[11px] text-slate-500">
          {from} → {to} · {events.length} event{events.length === 1 ? '' : 's'} · times shown in school time
        </p>

        {/* Events */}
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2">Details</th>
                <th className="px-3 py-2">Signature</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 italic">No attendance events in this range.</td></tr>
              ) : events.map((e) => {
                const by = e.performed_by_admin_email
                  ? `${e.performed_by_admin_email} (office)`
                  : e.performed_by_name_snapshot ?? '—';
                const details: string[] = [];
                if (e.curbside) details.push(e.curbside_slot ? `Curbside ${e.curbside_slot}` : 'Curbside');
                if (e.pickup_time) details.push(`Pickup ${e.pickup_time}`);
                if (e.event_type === 'check_out' && e.picked_up_by_name_snapshot && e.picked_up_by_name_snapshot !== e.performed_by_name_snapshot) {
                  details.push(`Picked up by ${e.picked_up_by_name_snapshot}`);
                }
                if (e.notes) details.push(e.notes);
                return (
                  <tr key={e.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-800">{dayOf(e.performed_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-slate-800">{timeOf(e.performed_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {e.event_type === 'check_in' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"><LogIn className="h-3 w-3" /> Check-in</span>
                      ) : e.event_type === 'check_out' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800"><LogOut className="h-3 w-3" /> Check-out</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-800"><UserX className="h-3 w-3" /> Absent</span>
                      )}
                      {e.source ? <span className="ml-1 align-middle rounded bg-slate-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">{e.source}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{by}</td>
                    <td className="px-3 py-2 text-slate-600 max-w-[16rem]">{details.join(' · ') || '—'}</td>
                    <td className="px-3 py-2">
                      {e.has_signature ? (
                        <a
                          href={`/api/school/attendance/signature/${e.id}${sigQ}`}
                          target="_blank" rel="noopener"
                          className="text-blue-700 hover:underline text-xs font-medium"
                        >
                          view
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
