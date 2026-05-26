// /school/[locationId]/staff-requests/calendar
//
// Month-grid view of staff requests by scheduled_date. Answers two
// questions:
//   - Teacher: "When is my Labor Request scheduled?"
//   - Lexi:    "What's on my plate this week?"
//
// Mode:
//   ?mode=mine  → only the cookie-identified teacher's submissions
//   ?mode=all   → every staff submission (Lexi's view)
// Defaults to mine when a teacher cookie is set, all otherwise.
//
// Month nav: ?month=YYYY-MM. Defaults to the current month.
// Click a chip → opens the submission's detail by drilling into the
// inbox URL (open=<id>) which already supports inline expansion.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ChevronLeft, ChevronRight, CalendarDays, Wrench, AlertCircle, Package, Inbox, Clock, CheckCircle2, CalendarCheck, XCircle, List } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity, isValidEmail, DGM_STAFF_DIRECTORY } from '@/lib/auth/teacher-identity';
import { ClassroomTopNav } from '@/components/ClassroomTopNav';
import { IdentityPicker } from '../IdentityPicker';
import { IdentityIndicator } from '../IdentityIndicator';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ month?: string; mode?: string; slug?: string; from?: string }>;

interface ScheduledRow {
  id: string;
  display_name: string;
  slug: string;
  scheduled_date: string;          // YYYY-MM-DD (date type comes back as string)
  resolved_status: string;
  submitter_email: string;
  admin_notes: string | null;
}

interface SlugCount {
  slug: string;
  display_name: string;
}

function isClassroomSlug(s: string | undefined): boolean {
  return !!s && /^(classroom-|program-)[a-z0-9-]+$/.test(s);
}
function prettyClassroom(slug: string): string {
  const stripped = slug.replace(/^(classroom-|program-)/, '');
  return slug.startsWith('classroom-')
    ? `Classroom ${stripped}`
    : stripped.toUpperCase().replace(/-/g, ' ');
}

// Parse ?month=YYYY-MM → first day of that month (UTC). Falls back to
// the current month if missing or malformed. Use UTC throughout so the
// grid doesn't shift around per viewer's timezone.
function parseMonth(s: string | undefined): { year: number; month: number; firstOfMonth: Date } {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-indexed
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    if (m >= 1 && m <= 12) { year = y; month = m - 1; }
  }
  return { year, month, firstOfMonth: new Date(Date.UTC(year, month, 1)) };
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Sunday on/before the 1st of the month. The grid is always weeks of
// 7 (Sun–Sat) starting from this anchor and running 5 or 6 weeks until
// we pass the last day of the month.
function startOfGrid(firstOfMonth: Date): Date {
  const dow = firstOfMonth.getUTCDay(); // 0=Sun
  const d = new Date(firstOfMonth);
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

export default async function StaffRequestsCalendarPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams;

  const classroomSlug = isClassroomSlug(sp.from) ? sp.from! : null;
  const classroomLabel = classroomSlug ? prettyClassroom(classroomSlug) : null;
  const fromQs = classroomSlug ? `&from=${classroomSlug}` : '';

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const teacher = await getTeacherIdentity();
  const teacherEmail = teacher?.email
    ?? (isValidEmail(session.user_email) && session.user_email !== 'embed@iframe' ? session.user_email : null);

  // Mode: explicit ?mode wins; otherwise default to 'mine' when we
  // know who they are, 'all' (Lexi view) when we don't.
  const explicitMode = sp.mode === 'mine' || sp.mode === 'all' ? sp.mode : null;
  const mode: 'mine' | 'all' = explicitMode ?? (teacherEmail ? 'mine' : 'all');
  const slugFilter = sp.slug ?? '';

  const { year, month, firstOfMonth } = parseMonth(sp.month);
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1));
  const monthLabel = firstOfMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Form types for the filter chip row — staff forms only. Pulled once
  // per render; cheap.
  const { rows: forms } = await query<SlugCount>(
    `SELECT slug, display_name
       FROM portal_form_definitions
      WHERE school_id = $1 AND audience='staff' AND is_active = true
      ORDER BY display_name`,
    [school.id],
  );

  // Pull every staff request that has a scheduled_date inside the
  // requested month. We always pull a single month; prev/next nav is
  // a new page load.
  //
  // mode=mine restricts to the teacher cookie email; mode=all returns
  // everything. mode=mine with no teacher email returns 0 rows
  // (we show the IdentityPicker in that case).
  const rows: ScheduledRow[] = (mode === 'mine' && !teacherEmail) ? [] : (await query<ScheduledRow>(
    `SELECT s.id, d.display_name, d.slug,
            to_char(s.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
            s.resolved_status, s.submitter_email, s.admin_notes
       FROM portal_form_submissions s
       JOIN portal_form_definitions d ON d.id = s.form_definition_id
      WHERE s.school_id = $1
        AND d.audience = 'staff'
        AND s.scheduled_date IS NOT NULL
        AND s.scheduled_date >= $2::date
        AND s.scheduled_date <  $3::date
        AND ($4 = '' OR d.slug = $4)
        AND ($5::text IS NULL OR s.submitter_email = $5)
      ORDER BY s.scheduled_date, s.submitted_at`,
    [school.id, ymd(firstOfMonth), ymd(firstOfNext), slugFilter, mode === 'mine' ? teacherEmail : null],
  )).rows;

  // Bucket rows per YYYY-MM-DD for fast lookup when rendering the
  // 35/42-day grid.
  const byDay = new Map<string, ScheduledRow[]>();
  for (const r of rows) {
    const list = byDay.get(r.scheduled_date);
    if (list) list.push(r);
    else byDay.set(r.scheduled_date, [r]);
  }

  // Build the grid: start Sunday on/before the 1st, run until we pass
  // the end of the month and have completed the week.
  const gridStart = startOfGrid(firstOfMonth);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    days.push(d);
    // Stop once we've crossed into the next month AND completed the
    // last week (Saturday). Keeps to 35 or 42 days.
    if (i >= 27 && d >= firstOfNext && d.getUTCDay() === 6) break;
  }

  // URL helpers — every nav link below extends this base set of params
  // so the month/mode/slug context survives across clicks.
  const baseQs = new URLSearchParams({ chrome: 'none' });
  if (mode !== (teacherEmail ? 'mine' : 'all')) baseQs.set('mode', mode);
  if (slugFilter) baseQs.set('slug', slugFilter);
  if (classroomSlug) baseQs.set('from', classroomSlug);

  const monthLink = (delta: number) => {
    const target = new Date(Date.UTC(year, month + delta, 1));
    const ym = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;
    const qs = new URLSearchParams(baseQs);
    qs.set('month', ym);
    return `/school/${locationId}/staff-requests/calendar?${qs.toString()}`;
  };
  const todayLink = () => {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const qs = new URLSearchParams(baseQs);
    qs.set('month', ym);
    return `/school/${locationId}/staff-requests/calendar?${qs.toString()}`;
  };
  const modeLink = (m: 'mine' | 'all') => {
    const qs = new URLSearchParams(baseQs);
    qs.set('mode', m);
    qs.set('month', `${year}-${String(month + 1).padStart(2, '0')}`);
    return `/school/${locationId}/staff-requests/calendar?${qs.toString()}`;
  };
  const slugLink = (s: string) => {
    const qs = new URLSearchParams(baseQs);
    if (s) qs.set('slug', s); else qs.delete('slug');
    qs.set('month', `${year}-${String(month + 1).padStart(2, '0')}`);
    return `/school/${locationId}/staff-requests/calendar?${qs.toString()}`;
  };

  // Link to the inbox/mine pages with open=<id> so clicking a chip
  // drops the user straight onto the expanded row.
  const detailLink = (r: ScheduledRow) => {
    if (mode === 'mine') {
      return `/school/${locationId}/staff-requests/mine?chrome=none${fromQs}`;
    }
    return `/school/${locationId}/staff-requests/inbox?chrome=none&status=all&open=${r.id}`;
  };

  const todayYmd = ymd(new Date());
  const thisUrl = `/school/${locationId}/staff-requests/calendar?chrome=none${fromQs}`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <ClassroomTopNav
          locationId={locationId}
          classroomSlug={classroomSlug}
          classroomLabel={classroomLabel}
          active="mine"
        />

        <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <CalendarDays className="h-6 w-6 text-blue-600" /> Request schedule
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {mode === 'mine'
                ? <>Your requests by the day they&rsquo;re scheduled. {teacherEmail ? <>Showing for <span className="font-mono">{teacherEmail}</span>.</> : null}</>
                : <>All staff requests by their scheduled fulfillment date.</>}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {teacher ? (
              <IdentityIndicator email={teacher.email} name={teacher.name} returnTo={thisUrl} />
            ) : null}
            <Link
              href={mode === 'mine'
                ? `/school/${locationId}/staff-requests/mine?chrome=none${fromQs}`
                : `/school/${locationId}/staff-requests/inbox?chrome=none`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <List className="h-3.5 w-3.5" /> List view
            </Link>
          </div>
        </div>

        {mode === 'mine' && !teacherEmail ? (
          <div className="mb-4">
            <IdentityPicker staff={DGM_STAFF_DIRECTORY} returnTo={thisUrl} />
          </div>
        ) : null}

        {/* View toggle + form-type filter */}
        <div className="flex items-center gap-2 mb-3 flex-wrap text-xs">
          <span className="uppercase tracking-wide text-slate-500 font-semibold">View:</span>
          <Link href={modeLink('mine')}
            className={mode === 'mine'
              ? 'rounded-full bg-blue-600 text-white px-3 py-1 font-semibold'
              : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-50'}>
            My requests
          </Link>
          <Link href={modeLink('all')}
            className={mode === 'all'
              ? 'rounded-full bg-blue-600 text-white px-3 py-1 font-semibold'
              : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-50'}>
            All requests
          </Link>
          <span className="text-slate-300 mx-1">|</span>
          <Link href={slugLink('')}
            className={!slugFilter
              ? 'rounded-full bg-slate-800 text-white px-3 py-1 font-semibold'
              : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-50'}>
            All forms
          </Link>
          {forms.map((f) => (
            <Link key={f.slug} href={slugLink(f.slug)}
              className={slugFilter === f.slug
                ? 'rounded-full bg-slate-800 text-white px-3 py-1 font-semibold'
                : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-slate-700 hover:bg-slate-50'}>
              {shortFormLabel(f.slug, f.display_name)}
            </Link>
          ))}
        </div>

        {/* Month navigation */}
        <div className="flex items-center justify-between mb-3">
          <Link href={monthLink(-1)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </Link>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">{monthLabel}</h2>
            <Link href={todayLink()}
              className="text-[11px] uppercase tracking-wide text-blue-600 hover:underline">
              Today
            </Link>
          </div>
          <Link href={monthLink(1)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {/* Calendar grid */}
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dn) => (
              <div key={dn} className="px-2 py-1.5 text-center">{dn}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 auto-rows-fr">
            {days.map((d) => {
              const key = ymd(d);
              const inMonth = d.getUTCMonth() === month;
              const isToday = key === todayYmd;
              const items = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={[
                    'border-b border-r border-slate-100 min-h-[110px] p-1.5',
                    inMonth ? 'bg-white' : 'bg-slate-50/60',
                    isToday ? 'ring-2 ring-blue-400 ring-inset' : '',
                  ].join(' ')}
                >
                  <div className={[
                    'text-[11px] font-semibold mb-1 flex items-center justify-between',
                    inMonth ? 'text-slate-700' : 'text-slate-400',
                  ].join(' ')}>
                    <span>{d.getUTCDate()}</span>
                    {items.length > 0 ? (
                      <span className="rounded-full bg-blue-100 text-blue-800 px-1.5 py-0 text-[9px] font-bold tabular-nums">
                        {items.length}
                      </span>
                    ) : null}
                  </div>
                  <ul className="space-y-1">
                    {items.map((it) => (
                      <li key={it.id}>
                        <Link
                          href={detailLink(it)}
                          className={[
                            'block rounded px-1.5 py-1 text-[10px] leading-tight hover:opacity-90 transition',
                            chipStyle(it.slug, it.resolved_status),
                          ].join(' ')}
                          title={`${it.display_name} · ${it.submitter_email} · ${it.resolved_status}${it.admin_notes ? ` · ${it.admin_notes}` : ''}`}
                        >
                          <span className="inline-flex items-center gap-1 font-semibold">
                            <FormIconSmall slug={it.slug} />
                            <span className="truncate">{shortFormLabel(it.slug, it.display_name)}</span>
                          </span>
                          {mode === 'all' ? (
                            <div className="mt-0.5 text-[9px] opacity-80 truncate">
                              {it.submitter_email.split('@')[0]}
                            </div>
                          ) : null}
                          <div className="mt-0.5">
                            <StatusChip status={it.resolved_status} />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 flex items-center gap-3 flex-wrap text-[11px] text-slate-600">
          <span className="uppercase tracking-wide font-semibold text-slate-500">Legend:</span>
          <span className="inline-flex items-center gap-1"><Wrench className="h-3 w-3 text-blue-600" /> Labor</span>
          <span className="inline-flex items-center gap-1"><AlertCircle className="h-3 w-3 text-rose-600" /> Incident</span>
          <span className="inline-flex items-center gap-1"><Package className="h-3 w-3 text-amber-600" /> Supplies</span>
          <span className="mx-1 text-slate-300">|</span>
          <StatusChip status="pending" />
          <StatusChip status="scheduled" />
          <StatusChip status="completed" />
          <StatusChip status="rejected" />
        </div>

        {/* Empty state hint */}
        {rows.length === 0 ? (
          <div className="mt-4 rounded-lg border-2 border-dashed border-slate-300 bg-white p-6 text-center">
            <p className="text-sm text-slate-700 font-medium">No scheduled requests in {monthLabel}</p>
            <p className="mt-1 text-xs text-slate-500">
              {mode === 'mine'
                ? <>When Lexi schedules a fulfillment date for one of your requests, it&rsquo;ll appear here.</>
                : <>Requests show up here once a scheduled date is set in the inbox.</>}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function FormIconSmall({ slug }: { slug: string }) {
  if (slug.includes('labor')) return <Wrench className="h-2.5 w-2.5 shrink-0" />;
  if (slug.includes('incident')) return <AlertCircle className="h-2.5 w-2.5 shrink-0" />;
  if (slug.includes('supply')) return <Package className="h-2.5 w-2.5 shrink-0" />;
  return <Inbox className="h-2.5 w-2.5 shrink-0" />;
}

// Compact label per form so chips stay tight inside the day cell.
function shortFormLabel(slug: string, displayName: string): string {
  if (slug.includes('labor')) return 'Labor';
  if (slug.includes('incident')) return 'Incident';
  if (slug.includes('supply')) return 'Supplies';
  return displayName;
}

// Color the chip by form type so Lexi can scan a day at a glance.
// Completed items fade so the visual weight matches their state.
function chipStyle(slug: string, status: string): string {
  const faded = status === 'completed' || status === 'rejected';
  if (slug.includes('labor'))    return faded ? 'bg-blue-50  text-blue-700  border border-blue-100'   : 'bg-blue-100  text-blue-900  border border-blue-200';
  if (slug.includes('incident')) return faded ? 'bg-rose-50  text-rose-700  border border-rose-100'   : 'bg-rose-100  text-rose-900  border border-rose-200';
  if (slug.includes('supply'))   return faded ? 'bg-amber-50 text-amber-700 border border-amber-100'  : 'bg-amber-100 text-amber-900 border border-amber-200';
  return faded ? 'bg-slate-50 text-slate-600 border border-slate-100' : 'bg-slate-100 text-slate-800 border border-slate-200';
}

function StatusChip({ status }: { status: string }) {
  const cfg = {
    pending:      { bg: 'bg-amber-200',   fg: 'text-amber-900',   Icon: Clock,         label: 'Pending' },
    acknowledged: { bg: 'bg-blue-200',    fg: 'text-blue-900',    Icon: AlertCircle,   label: 'Ack' },
    scheduled:    { bg: 'bg-violet-200',  fg: 'text-violet-900',  Icon: CalendarCheck, label: 'Scheduled' },
    completed:    { bg: 'bg-emerald-200', fg: 'text-emerald-900', Icon: CheckCircle2,  label: 'Done' },
    rejected:     { bg: 'bg-rose-200',    fg: 'text-rose-900',    Icon: XCircle,       label: 'Rejected' },
  }[status] ?? { bg: 'bg-slate-200', fg: 'text-slate-800', Icon: Clock, label: status };
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full ${cfg.bg} px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide ${cfg.fg}`}>
      <cfg.Icon className="h-2.5 w-2.5" /> {cfg.label}
    </span>
  );
}
