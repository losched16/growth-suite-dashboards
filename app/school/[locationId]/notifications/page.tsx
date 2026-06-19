// /school/[locationId]/notifications — admin compose + send in-portal
// notifications to parents, plus a list of what's been sent with read
// counts. Lives in /school/* so it stays inside the embedded iframe.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Bell, Pin } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { loadAudienceOptions } from '@/lib/notifications/audience';
import { ComposeNotification } from './ComposeNotification';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ locationId: string }>;

interface SentRow {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  audience_label: string | null;
  recipient_count: number;
  read_count: number;
  created_at: string;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default async function NotificationsPage({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const options = await loadAudienceOptions(school.id);

  const { rows: sent } = await query<SentRow>(
    `SELECT n.id, n.title, n.body, n.pinned, n.audience_label, n.recipient_count,
            (SELECT COUNT(*) FROM portal_notification_recipients r
              WHERE r.notification_id = n.id AND r.read_at IS NOT NULL)::int AS read_count,
            n.created_at
       FROM portal_notifications n
      WHERE n.school_id = $1
      ORDER BY n.created_at DESC
      LIMIT 25`,
    [school.id],
  );

  return (
    <main className="flex flex-1 flex-col items-center bg-slate-50 p-6 min-h-screen">
      <div className="w-full max-w-3xl space-y-5">
        <Link href={`/school/${locationId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-3 w-3" /> Back
        </Link>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Bell className="h-5 w-5 text-emerald-700" /> Parent notifications
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Send a message into families&rsquo; portals — to everyone, a program, a classroom, a grade, a tag, or a specific family.
          </p>
        </div>

        <ComposeNotification schoolId={school.id} options={options} />

        {/* Sent history */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">Sent</h2>
          {sent.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              Nothing sent yet. Your first notification will appear here.
            </div>
          ) : (
            <ul className="space-y-2">
              {sent.map((n) => (
                <li key={n.id} className="rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {n.pinned ? <Pin className="h-3 w-3 text-amber-600" /> : null}
                        <span className="font-semibold text-slate-900 text-sm truncate">{n.title}</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{n.body}</p>
                      <div className="mt-1 text-[11px] text-slate-400">
                        {n.audience_label ?? '—'} · {fmt(n.created_at)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold text-slate-900 tabular-nums">
                        {n.read_count}/{n.recipient_count}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">read</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
