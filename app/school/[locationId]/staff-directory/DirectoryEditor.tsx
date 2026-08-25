'use client';

// Add/remove UI for the staff identity roster. Talks to
// /api/school/staff-directory (school-session cookie auth); every
// response returns the fresh list so the table never goes stale.

import { useState } from 'react';
import { Trash2, UserPlus, Loader2 } from 'lucide-react';

interface Staff { email: string; name: string }

export function DirectoryEditor({ initialStaff }: { initialStaff: Staff[] }) {
  const [staff, setStaff] = useState<Staff[]>(initialStaff);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'add' | email being removed
  const [error, setError] = useState<string | null>(null);

  async function call(method: 'POST' | 'DELETE', body: Record<string, string>) {
    const res = await fetch('/api/school/staff-directory', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(
        data?.error === 'invalid_email' ? 'That email address doesn’t look valid.'
        : data?.error === 'name_required' ? 'A display name is required.'
        : 'Something went wrong — try again.',
      );
    }
    setStaff(data.staff as Staff[]);
  }

  async function add() {
    setError(null);
    setBusy('add');
    try {
      await call('POST', { email: email.trim(), name: name.trim() });
      setName('');
      setEmail('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(target: Staff) {
    if (!window.confirm(`Remove ${target.name} (${target.email}) from the pick-list?`)) return;
    setError(null);
    setBusy(target.email);
    try {
      await call('DELETE', { email: target.email });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900 mb-2">Add a person</h2>
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name (e.g. J. Smith)"
            className="flex-1 min-w-[160px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            className="flex-1 min-w-[220px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={add}
            disabled={busy !== null || !name.trim() || !email.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Add
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Adding an email that&rsquo;s already listed updates that person&rsquo;s display name.
        </p>
        {error ? <p className="text-xs text-rose-600 mt-2">{error}</p> : null}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <h2 className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-900">
          Current list <span className="ml-1 font-normal text-slate-400">({staff.length})</span>
        </h2>
        {staff.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">
            Nobody in the directory yet — add the first person above.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {staff.map((s) => (
              <li key={s.email} className="flex items-center justify-between gap-3 px-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-slate-800">{s.name}</span>
                  <span className="ml-2 text-xs text-slate-500 break-all">{s.email}</span>
                </div>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  disabled={busy !== null}
                  title={`Remove ${s.name}`}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                >
                  {busy === s.email ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
