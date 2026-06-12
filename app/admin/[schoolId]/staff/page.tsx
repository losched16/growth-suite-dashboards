// /admin/[schoolId]/staff — who can sign in to this school's dashboards
// directly (magic link at /staff). The non-GHL auth path for standalone
// schools; harmless to use for embedded schools too (a second door).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, UserPlus, ShieldCheck } from 'lucide-react';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function StaffPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  const { rows: staff } = await query<{
    id: string; email: string; name: string | null; role: string; status: string; created_at: string;
  }>(
    `SELECT id, email, name, role, status, created_at
       FROM school_staff WHERE school_id = $1 ORDER BY status, email`,
    [schoolId],
  );
  const active = staff.filter((s) => s.status === 'active');
  const inactive = staff.filter((s) => s.status !== 'active');

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-3xl space-y-4">
        <Link href={`/admin/${schoolId}`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> {school.name}
        </Link>

        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-700" />
          <h1 className="text-2xl font-semibold text-zinc-900">Staff sign-in access</h1>
        </div>
        <p className="text-sm text-zinc-600 max-w-2xl">
          People listed here can sign in to {school.name}&apos;s dashboards directly at{' '}
          <code className="rounded bg-zinc-100 px-1">/staff</code> with an emailed one-time link —
          no Growth Suite embed required. This is how standalone schools access everything.
        </p>

        {sp.msg ? <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
        {sp.err ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

        {/* Add */}
        <form action={`/api/admin/schools/${schoolId}/staff`} method="POST"
          className="rounded-xl border border-black/10 bg-white p-4 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
          <input type="hidden" name="op" value="add" />
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Email *</span>
            <input type="email" name="email" required placeholder="cfo@school.org"
              className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Name</span>
            <input type="text" name="name" placeholder="Kim Smith"
              className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Role</span>
            <select name="role" className="mt-0.5 rounded border border-zinc-300 px-2 py-1.5 text-sm">
              <option value="admin">Admin</option>
              <option value="staff">Staff</option>
            </select>
          </label>
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
            <UserPlus className="h-4 w-4" /> Add
          </button>
        </form>

        {/* Active list */}
        <section className="rounded-xl border border-black/10 bg-white overflow-hidden">
          <div className="border-b border-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-700">
            Active ({active.length})
          </div>
          {active.length === 0 ? (
            <p className="p-6 text-sm text-zinc-500 italic">Nobody yet — add the school&apos;s admin above.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-100">
                {active.map((s) => (
                  <tr key={s.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-2 font-medium text-zinc-900">{s.name ?? '—'}</td>
                    <td className="px-4 py-2 text-zinc-700">{s.email}</td>
                    <td className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500">{s.role}</td>
                    <td className="px-4 py-2 text-right">
                      <form action={`/api/admin/schools/${schoolId}/staff`} method="POST" className="inline">
                        <input type="hidden" name="op" value="remove" />
                        <input type="hidden" name="staff_id" value={s.id} />
                        <button type="submit" className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50">
                          Remove access
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {inactive.length > 0 ? (
          <p className="text-xs text-zinc-500">{inactive.length} removed member{inactive.length === 1 ? '' : 's'} (re-add by email to restore).</p>
        ) : null}
      </div>
    </main>
  );
}
