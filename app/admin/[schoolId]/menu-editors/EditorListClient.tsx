'use client';

// Client-side CRUD for the editor allowlist. Lives inside the admin
// page so adds/removes feel snappy — every mutation calls the API,
// re-fetches the list, and re-renders without a page nav.

import { useState, type FormEvent } from 'react';
import { Trash2, Loader2, UserCircle } from 'lucide-react';

interface Editor { id: string; email: string; name: string | null; created_at: string }

export function EditorListClient({
  schoolId,
  initialEditors,
}: {
  schoolId: string;
  initialEditors: Editor[];
}) {
  const [editors, setEditors] = useState<Editor[]>(initialEditors);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch(`/api/admin/schools/${schoolId}/menu-editors`);
    const j = await r.json();
    if (Array.isArray(j.editors)) setEditors(j.editors);
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/menu-editors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
      } else {
        setEmail('');
        setName('');
        await refresh();
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this editor? They will lose menu upload access.')) return;
    const r = await fetch(`/api/admin/schools/${schoolId}/menu-editors?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (r.ok) await refresh();
  }

  return (
    <>
      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Email *</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="lexi@desertgardenmontessori.org"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Display name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lexi Smith"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="self-end inline-flex items-center gap-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Add editor
        </button>
      </form>

      {err ? (
        <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{err}</div>
      ) : null}

      <div className="mt-4 border-t border-slate-100 pt-3">
        {editors.length === 0 ? (
          <p className="text-xs italic text-slate-500">No editors yet — add at least one so the menu CMS isn&rsquo;t orphaned.</p>
        ) : (
          <ul className="space-y-2">
            {editors.map((ed) => (
              <li key={ed.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <UserCircle className="h-5 w-5 text-blue-600" />
                  <div>
                    <div className="text-sm font-medium text-slate-900">
                      {ed.name || ed.email}
                    </div>
                    {ed.name ? <div className="text-[11px] text-slate-500">{ed.email}</div> : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(ed.id)}
                  className="inline-flex items-center gap-1 rounded border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                  title="Remove this editor"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
