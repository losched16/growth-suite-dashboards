'use client';

// Family/student picker for the Send-form page. Plain form POST to the
// invite endpoint (no fetch — the endpoint 303s back here with the result).

import { useMemo, useState } from 'react';
import { Search, Send } from 'lucide-react';

interface Family { id: string; label: string; parent_email: string | null }
interface Student { id: string; family_id: string; name: string }

export function SendFormClient({
  schoolId, formId, perStudent, returnTo, families, students,
}: {
  schoolId: string;
  formId: string;
  perStudent: boolean;
  returnTo: string;
  families: Family[];
  students: Student[];
}) {
  const [search, setSearch] = useState('');
  const [familyId, setFamilyId] = useState('');

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return families.slice(0, 12);
    return families.filter((f) =>
      f.label.toLowerCase().includes(q)
      || (f.parent_email ?? '').toLowerCase().includes(q)
      || students.some((s) => s.family_id === f.id && s.name.toLowerCase().includes(q)),
    ).slice(0, 12);
  }, [search, families, students]);

  const familyStudents = useMemo(
    () => students.filter((s) => s.family_id === familyId),
    [students, familyId],
  );
  const selected = families.find((f) => f.id === familyId) ?? null;

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none';

  return (
    <form action={`/api/admin/schools/${schoolId}/enrollments/start`} method="POST"
      className="space-y-4 rounded-xl border border-black/10 bg-white p-5">
      <input type="hidden" name="form_definition_id" value={formId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="family_id" value={familyId} />

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Family</label>
        {selected ? (
          <div className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm">
            <span className="truncate text-emerald-900">{selected.label}
              {selected.parent_email ? <span className="text-emerald-700/70"> · {selected.parent_email}</span> : null}</span>
            <button type="button" onClick={() => setFamilyId('')} className="shrink-0 text-xs text-emerald-700 underline">change</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
                placeholder="Search by parent, student, or email…"
                className="w-full bg-transparent text-sm focus:outline-none" />
            </div>
            <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200">
              {matches.map((f) => (
                <button key={f.id} type="button" onClick={() => setFamilyId(f.id)}
                  className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-800 last:border-0 hover:bg-emerald-50">
                  {f.label}
                  {f.parent_email ? <span className="text-slate-400"> · {f.parent_email}</span> : null}
                  <span className="block text-[11px] text-slate-400">
                    {students.filter((s) => s.family_id === f.id).map((s) => s.name).join(', ') || 'no students on file'}
                  </span>
                </button>
              ))}
              {matches.length === 0 ? <div className="px-3 py-2 text-xs text-slate-400">No matches.</div> : null}
            </div>
          </>
        )}
      </div>

      {perStudent && familyId ? (
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">For which child</label>
          <select name="student_id" required className={input} defaultValue="">
            <option value="" disabled>Pick a student…</option>
            {familyStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      ) : null}

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Internal note (optional — staff only)</label>
        <input name="internal_note" className={input} placeholder="e.g. requested by mom at pickup 7/2" />
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="send_email" value="1" defaultChecked className="mt-0.5 h-4 w-4 rounded border-slate-300" />
        <span>
          Email the family now
          <span className="block text-[11px] text-slate-500">Every active parent in the family gets &ldquo;Action needed: (form name)&rdquo; with a one-click link. Uncheck to just generate a link you can copy.</span>
        </span>
      </label>

      <button type="submit" disabled={!familyId}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
        <Send className="h-4 w-4" /> Send form
      </button>
    </form>
  );
}
