// Operator view of every parent upload for a school. Lets staff:
//   - See what's been uploaded recently
//   - Download the raw file
//   - Mark as acknowledged (so the parent sees a "school has received it" badge)
//   - Retry GHL push for any that failed to sync
//   - Filter by student / form / sync state

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string; filter?: string }>;

interface SchoolRow {
  id: string;
  name: string;
  ghl_location_id: string;
}

interface UploadRow {
  id: string;
  display_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  notes: string | null;
  uploaded_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by_email: string | null;
  ghl_synced_at: Date | null;
  ghl_sync_error: string | null;
  ghl_media_url: string | null;
  ghl_conversation_id: string | null;
  family_id: string;
  family_display_name: string | null;
  primary_parent_name: string | null;
  primary_parent_email: string | null;
  student_name: string | null;
  form_name: string | null;
  uploaded_by_name: string | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return d.toLocaleDateString();
}

export default async function UploadsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { schoolId } = await params;
  const { msg, err, filter } = await searchParams;

  const { rows: schoolRows } = await query<SchoolRow>(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`,
    [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Counts per filter for the segmented control
  const { rows: countsRows } = await query<{
    total: string;
    unsynced: string;
    failed: string;
    unack: string;
  }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE ghl_synced_at IS NULL AND (ghl_sync_error IS NULL OR ghl_sync_error = '')) AS unsynced,
       count(*) FILTER (WHERE ghl_sync_error IS NOT NULL AND ghl_sync_error <> '') AS failed,
       count(*) FILTER (WHERE acknowledged_at IS NULL) AS unack
     FROM parent_uploads WHERE school_id = $1`,
    [schoolId],
  );
  const counts = countsRows[0];

  // Filter clause
  let whereClause = '';
  if (filter === 'failed') whereClause = " AND u.ghl_sync_error IS NOT NULL AND u.ghl_sync_error <> ''";
  else if (filter === 'unsynced') whereClause = " AND u.ghl_synced_at IS NULL AND (u.ghl_sync_error IS NULL OR u.ghl_sync_error = '')";
  else if (filter === 'unack') whereClause = ' AND u.acknowledged_at IS NULL';

  const { rows: uploads } = await query<UploadRow>(
    `SELECT
       u.id, u.display_name, u.original_filename, u.mime_type, u.size_bytes,
       u.notes, u.uploaded_at, u.acknowledged_at, u.acknowledged_by_email,
       u.ghl_synced_at, u.ghl_sync_error, u.ghl_media_url, u.ghl_conversation_id,
       f.id AS family_id, f.display_name AS family_display_name,
       (SELECT first_name || ' ' || last_name FROM parents pp
        WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_parent_name,
       (SELECT email FROM parents pp
        WHERE pp.family_id = f.id AND pp.is_primary = true LIMIT 1) AS primary_parent_email,
       (s.first_name || ' ' || s.last_name) AS student_name,
       sf.display_name AS form_name,
       (p.first_name || ' ' || p.last_name) AS uploaded_by_name
     FROM parent_uploads u
     JOIN families f ON f.id = u.family_id
     LEFT JOIN students s ON s.id = u.student_id
     LEFT JOIN school_forms sf ON sf.id = u.form_id
     LEFT JOIN parents p ON p.id = u.parent_id
     WHERE u.school_id = $1 ${whereClause}
     ORDER BY u.uploaded_at DESC
     LIMIT 200`,
    [schoolId],
  );

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-5xl space-y-4">
        <div>
          <Link href={`/admin/${schoolId}`} className="text-xs text-zinc-500 hover:text-zinc-700">
            ← Back to {school.name}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Family uploads</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Documents parents have uploaded via the family portal.
            They sync to GHL Media + the parent&apos;s contact conversation thread.
          </p>
        </div>

        {msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
        ) : null}
        {err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
        ) : null}

        {/* Filter pills */}
        <div className="flex flex-wrap gap-1 text-xs">
          {([
            { key: '',         label: 'All',          count: counts.total },
            { key: 'failed',   label: 'Failed sync',  count: counts.failed },
            { key: 'unsynced', label: 'Pending sync', count: counts.unsynced },
            { key: 'unack',    label: 'Unacknowledged', count: counts.unack },
          ] as const).map((f) => {
            const active = (filter ?? '') === f.key;
            return (
              <a
                key={f.key}
                href={f.key ? `?filter=${f.key}` : '?'}
                className={`rounded-full px-2.5 py-1 ${active ? 'bg-zinc-900 text-white' : 'bg-white border border-zinc-300 text-zinc-700 hover:bg-zinc-50'}`}
              >
                {f.label} <span className="opacity-70">· {f.count}</span>
              </a>
            );
          })}
        </div>

        {uploads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
            {filter ? 'No uploads match the current filter.' : 'No documents have been uploaded yet.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-black/10 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-black/10 text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Document</th>
                  <th className="px-4 py-3 font-medium">Family / Student</th>
                  <th className="px-4 py-3 font-medium">Sync</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {uploads.map((u) => (
                  <tr key={u.id} className="hover:bg-zinc-50/50 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900">{u.display_name}</div>
                      <div className="text-[11px] text-zinc-500">
                        {fmtBytes(u.size_bytes)} · {u.mime_type} · {fmtRelative(new Date(u.uploaded_at))}
                        {u.uploaded_by_name ? ` by ${u.uploaded_by_name}` : ''}
                      </div>
                      {u.form_name ? <div className="text-[11px] text-zinc-500 italic">for: {u.form_name}</div> : null}
                      {u.notes ? <div className="mt-0.5 text-[11px] text-zinc-600 italic">&ldquo;{u.notes}&rdquo;</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-zinc-900">{u.family_display_name ?? '(unnamed family)'}</div>
                      <div className="text-[11px] text-zinc-500">
                        {u.primary_parent_name ?? '(no primary parent)'} ·{' '}
                        {u.primary_parent_email ? (
                          <a href={`mailto:${u.primary_parent_email}`} className="text-emerald-700 hover:underline">{u.primary_parent_email}</a>
                        ) : '(no email)'}
                      </div>
                      {u.student_name ? <div className="text-[11px] text-zinc-500">student: {u.student_name}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {u.ghl_synced_at ? (
                        <div>
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
                            ✓ in GHL
                          </span>
                          <div className="mt-1 text-[10px] text-zinc-500">
                            {fmtRelative(new Date(u.ghl_synced_at))}
                          </div>
                          {u.ghl_media_url ? (
                            <a href={u.ghl_media_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block text-[10px] text-emerald-700 hover:underline">
                              View in GHL ↗
                            </a>
                          ) : null}
                        </div>
                      ) : u.ghl_sync_error ? (
                        <div>
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-800">
                            sync failed
                          </span>
                          <div className="mt-1 text-[10px] text-rose-700 truncate max-w-[16rem]" title={u.ghl_sync_error}>
                            {u.ghl_sync_error}
                          </div>
                        </div>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                          pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`/api/admin/uploads/${u.id}/download`}
                        className="mr-2 inline-block rounded border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                      >
                        Download
                      </a>
                      {!u.ghl_synced_at ? (
                        <form action={`/api/admin/uploads/${u.id}/retry`} method="POST" className="inline-block mr-2">
                          <button type="submit" className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100">
                            Retry sync
                          </button>
                        </form>
                      ) : null}
                      {!u.acknowledged_at ? (
                        <form action={`/api/admin/uploads/${u.id}/acknowledge`} method="POST" className="inline-block">
                          <button type="submit" className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50">
                            Acknowledge
                          </button>
                        </form>
                      ) : (
                        <span className="text-[10px] text-zinc-500">✓ acknowledged</span>
                      )}
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
