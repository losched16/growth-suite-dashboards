'use client';

// Recipient picker for the Send-form page. Plain form POST to the invite
// endpoint (no fetch — the endpoint 303s back here with the result).
//
// Modes: one family (searchable picker, optional per-student), all families,
// or a group by contact tag / program / grade. Group modes show a live
// recipient estimate and confirm before sending — a mis-click here would
// email the whole school.

import { useMemo, useState } from 'react';
import { Search, Send, Users } from 'lucide-react';

interface Family { id: string; label: string; parent_email: string | null }
interface Student {
  id: string; family_id: string; name: string;
  program: string | null; grade: string | null; enr_status: string | null;
}

type Mode = 'family' | 'all' | 'tag' | 'program' | 'grade';

const MODE_LABEL: Record<Mode, string> = {
  family: 'One family',
  all: 'All families',
  tag: 'By tag',
  program: 'By program',
  grade: 'By grade',
};

export function SendFormClient({
  schoolId, formId, formName, perStudent, returnTo, families, students,
  familyTags, tagOptions, programOptions, gradeOptions,
}: {
  schoolId: string;
  formId: string;
  formName: string;
  perStudent: boolean;
  returnTo: string;
  families: Family[];
  students: Student[];
  familyTags: Record<string, string[]>;
  tagOptions: string[];
  programOptions: string[];
  gradeOptions: string[];
}) {
  const [mode, setMode] = useState<Mode>('family');
  const [search, setSearch] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [groupValue, setGroupValue] = useState('');

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

  // Live estimate for group modes — mirrors the server's scope: families
  // with at least one enrolled/pending student (withdrawn + stale
  // prospects never get group pushes).
  const scopedFamilyIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of students) {
      if (s.enr_status === 'enrolled' || s.enr_status === 'pending') set.add(s.family_id);
    }
    return set;
  }, [students]);

  const estimatedFamilies = useMemo(() => {
    if (mode === 'family') return selected ? 1 : 0;
    if (mode === 'all') return scopedFamilyIds.size;
    if (!groupValue) return 0;
    const v = groupValue.toLowerCase();
    if (mode === 'tag') {
      let n = 0;
      for (const fid of scopedFamilyIds) {
        if ((familyTags[fid] ?? []).some((t) => t.toLowerCase() === v)) n++;
      }
      return n;
    }
    // program / grade
    const set = new Set<string>();
    for (const s of students) {
      if (!scopedFamilyIds.has(s.family_id)) continue;
      const field = mode === 'program' ? s.program : s.grade;
      if ((field ?? '').toLowerCase() === v) set.add(s.family_id);
    }
    return set.size;
  }, [mode, groupValue, selected, scopedFamilyIds, students, familyTags]);

  const groupOptions = mode === 'tag' ? tagOptions : mode === 'program' ? programOptions : gradeOptions;
  const canSubmit = mode === 'family' ? !!familyId : mode === 'all' ? true : !!groupValue;

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none';

  return (
    <form
      action={`/api/admin/schools/${schoolId}/enrollments/start`}
      method="POST"
      onSubmit={(e) => {
        if (mode === 'family') return;
        const ok = window.confirm(
          `Push "${formName}" to ${estimatedFamilies} famil${estimatedFamilies === 1 ? 'y' : 'ies'}`
          + `${mode === 'all' ? '' : ` (${MODE_LABEL[mode].toLowerCase()}: ${groupValue})`}?`
          + `\n\nEvery parent in those families gets the "form waiting in your portal" email.`,
        );
        if (!ok) e.preventDefault();
      }}
      className="space-y-4 rounded-xl border border-black/10 bg-white p-5"
    >
      <input type="hidden" name="form_definition_id" value={formId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="recipient_mode" value={mode} />
      <input type="hidden" name="family_id" value={mode === 'family' ? familyId : ''} />
      <input type="hidden" name="group_value" value={mode === 'family' || mode === 'all' ? '' : groupValue} />

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Send to</label>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <button
              key={m} type="button"
              onClick={() => { setMode(m); setGroupValue(''); }}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                mode === m
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-emerald-400'
              }`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      {mode === 'family' ? (
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
      ) : null}

      {mode === 'family' && perStudent && familyId ? (
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">For which child</label>
          <select name="student_id" className={input} defaultValue="">
            <option value="">Whole family (all children)</option>
            {familyStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      ) : null}

      {mode === 'tag' || mode === 'program' || mode === 'grade' ? (
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {mode === 'tag' ? 'Contact tag' : mode === 'program' ? 'Program' : 'Grade'}
          </label>
          <select value={groupValue} onChange={(e) => setGroupValue(e.target.value)} className={input}>
            <option value="">Pick {mode === 'tag' ? 'a tag' : mode === 'program' ? 'a program' : 'a grade'}…</option>
            {groupOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      ) : null}

      {mode !== 'family' ? (
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <Users className="h-4 w-4 shrink-0 text-slate-400" />
          {canSubmit
            ? <span><strong>{estimatedFamilies}</strong> famil{estimatedFamilies === 1 ? 'y' : 'ies'} will get this form (enrolled + pending only).</span>
            : <span>Pick a value to see how many families this reaches.</span>}
        </div>
      ) : null}

      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500">Internal note (optional — staff only)</label>
        <input name="internal_note" className={input} placeholder="e.g. requested by mom at pickup 7/2" />
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="send_email" value="1" defaultChecked className="mt-0.5 h-4 w-4 rounded border-slate-300" />
        <span>
          Email the famil{mode === 'family' ? 'y' : 'ies'} now
          <span className="block text-[11px] text-slate-500">
            Each parent gets &ldquo;You have a form waiting in your Family Portal: {formName}&rdquo; with a
            one-click link. Uncheck to just push it into their portal silently.
          </span>
        </span>
      </label>

      <button type="submit" disabled={!canSubmit}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
        <Send className="h-4 w-4" /> {mode === 'family' ? 'Send form' : `Push to ${canSubmit ? estimatedFamilies : '…'} families`}
      </button>
    </form>
  );
}
