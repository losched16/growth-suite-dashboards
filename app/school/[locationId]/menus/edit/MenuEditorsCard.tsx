'use client';

// "Who can post menus" — lets a current editor add a colleague from the
// staff directory (or by email) and remove people who no longer need it.

import { useState } from 'react';
import { Loader2, Trash2, UserPlus, Users } from 'lucide-react';

interface Editor { id: string; email: string; name: string | null }
interface Staff { email: string; name: string }

export function MenuEditorsCard({
  initialEditors, staff, myEmail,
}: {
  initialEditors: Editor[];
  staff: Staff[];
  myEmail: string;
}) {
  const [editors, setEditors] = useState(initialEditors);
  const [pick, setPick] = useState('');
  const [otherEmail, setOtherEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const have = new Set(editors.map((e) => e.email.toLowerCase()));
  const available = staff.filter((s) => !have.has(s.email.toLowerCase()));
  const adding = pick === '__other__' ? { email: otherEmail.trim().toLowerCase(), name: '' }
    : available.find((s) => s.email === pick) ?? null;

  async function add() {
    if (!adding?.email) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/school/menus/editors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adding.email, name: adding.name || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); return; }
      const created = j.editor as Editor | undefined;
      if (created) setEditors((prev) => (prev.some((x) => x.id === created.id) ? prev : [...prev, created]));
      setPick('');
      setOtherEmail('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(ed: Editor) {
    if (!confirm(`Remove ${ed.name || ed.email}? They will no longer be able to post menus.`)) return;
    setErr(null);
    const r = await fetch(`/api/school/menus/editors?id=${encodeURIComponent(ed.id)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); return; }
    setEditors((prev) => prev.filter((x) => x.id !== ed.id));
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <header className="px-4 py-3 border-b border-slate-100 bg-slate-50">
        <h3 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
          <Users className="h-4 w-4 text-blue-600" /> Who can post menus
        </h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          These staff members can post and replace the menus. Add whoever handles the monthly lunch calendar.
        </p>
      </header>
      <div className="p-4 space-y-3">
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {editors.map((ed) => (
            <li key={ed.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{ed.name || ed.email}</span>
                {ed.name ? <span className="ml-2 text-xs text-slate-500">{ed.email}</span> : null}
                {ed.email.toLowerCase() === myEmail.toLowerCase() ? <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">you</span> : null}
              </span>
              {ed.email.toLowerCase() === myEmail.toLowerCase() ? null : (
                <button type="button" onClick={() => remove(ed)} className="text-slate-400 hover:text-rose-600" title="Remove">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-end gap-2 flex-wrap">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-600">Add an editor</span>
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="mt-1 block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            >
              <option value="">Choose a staff member…</option>
              {available.map((s) => <option key={s.email} value={s.email}>{s.name} — {s.email}</option>)}
              <option value="__other__">Someone not listed (type their email)…</option>
            </select>
          </label>
          {pick === '__other__' ? (
            <input
              type="email"
              value={otherEmail}
              onChange={(e) => setOtherEmail(e.target.value)}
              placeholder="name@yourschool.org"
              className="block rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            />
          ) : null}
          <button
            type="button"
            onClick={add}
            disabled={busy || !adding?.email}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
            Add
          </button>
        </div>
        {err ? <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">{err}</div> : null}
      </div>
    </section>
  );
}
