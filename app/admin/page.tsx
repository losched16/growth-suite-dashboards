import Link from 'next/link';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type SchoolRow = {
  id: string;
  name: string;
  ghl_location_id: string;
  dashboard_count: number;
};

export default async function AdminHome() {
  const { rows } = await query<SchoolRow>(`
    SELECT
      s.id,
      s.name,
      s.ghl_location_id,
      COALESCE((SELECT COUNT(*)::int FROM school_dashboards d WHERE d.school_id = s.id), 0) AS dashboard_count
    FROM schools s
    ORDER BY s.name
  `);

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-4xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Dashboards
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {rows.length} schools
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/admin/billing-status"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              Billing Status →
            </Link>
            <Link
              href="/admin/schools/new"
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
            >
              + Add school
            </Link>
            <form action="/api/logout" method="POST">
              <button
                type="submit"
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        <div className="overflow-hidden rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-zinc-950">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No schools yet. Add one in the importer first.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-black/10 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">School</th>
                  <th className="px-4 py-3 font-medium">Location ID</th>
                  <th className="px-4 py-3 font-medium text-right">Dashboards</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/5">
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                      <Link href={`/admin/${s.id}`} className="hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                      {s.ghl_location_id}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-700 dark:text-zinc-300">
                      {s.dashboard_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}
