'use client';

// Searchable student combobox used in the incident-report form.
//
// On mount, fetches the school's active student list (id + name +
// homeroom). Teacher types to filter; selects a kid; the chosen
// student id is posted as a hidden form field named `<key>`. The
// submit endpoint detects the corresponding schema field type
// (`student_picker`) and does the parent lookup server-side so the
// inbox can show "Notify: Mom (jane@dgm.org, 555-1234) · Dad
// (john@dgm.org)".
//
// Why client-side: the host page is a server component and the rest
// of the form mounts in a single client form wrapper (StaffSubmitForm).
// Keeping the picker client-side means filtering happens locally
// (~300 students, snappy) and the form re-mounts don't refetch.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, UserCircle, ChevronDown, AlertCircle } from 'lucide-react';

interface Student {
  id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  homeroom: string | null;
}

function displayName(s: Student): string {
  const first = s.preferred_name?.trim() || s.first_name;
  return `${first} ${s.last_name}`.trim();
}

export function StudentIncidentPicker({
  name, label, required, help,
}: {
  name: string;
  label: string;
  required: boolean;
  help: string | null;
}) {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Student | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/school/students');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !Array.isArray(j.students)) {
          setErr(j.error || `HTTP ${r.status}`);
          return;
        }
        setStudents(j.students);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filtered = useMemo(() => {
    if (!students) return [];
    const term = q.trim().toLowerCase();
    if (!term) return students.slice(0, 50);
    return students
      .filter((s) => {
        const nm = displayName(s).toLowerCase();
        const room = (s.homeroom ?? '').toLowerCase();
        return nm.includes(term) || room.includes(term) || s.last_name.toLowerCase().includes(term);
      })
      .slice(0, 50);
  }, [students, q]);

  function pick(s: Student) {
    setPicked(s);
    setOpen(false);
    setQ('');
  }

  function clear() {
    setPicked(null);
    setQ('');
    setOpen(true);
  }

  return (
    <div className="block" ref={rootRef}>
      <span className="text-sm font-medium text-zinc-800">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </span>
      {help ? <span className="block text-[11px] text-zinc-500 mt-0.5">{help}</span> : null}

      {/* Hidden input — this is what the form actually submits. */}
      <input type="hidden" name={name} value={picked?.id ?? ''} required={required} />

      {picked ? (
        <div className="mt-1 flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <UserCircle className="h-5 w-5 text-emerald-700" />
            <div>
              <div className="text-sm font-semibold text-slate-900">{displayName(picked)}</div>
              {picked.homeroom ? (
                <div className="text-[11px] text-slate-600">{picked.homeroom}</div>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={clear} className="text-slate-500 hover:text-slate-800" title="Pick a different student">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative mt-1">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              placeholder={students == null ? 'Loading students…' : 'Search by name or classroom…'}
              disabled={students == null}
              className="w-full rounded-md border border-zinc-300 bg-white pl-8 pr-8 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-200"
            />
            <ChevronDown className="absolute right-2 top-2.5 h-4 w-4 text-zinc-400 pointer-events-none" />
          </div>

          {open && students != null ? (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-zinc-200 bg-white shadow-lg">
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs italic text-zinc-500">
                  {q.trim() ? 'No matches.' : 'No students on file.'}
                </div>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {filtered.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                        className="w-full text-left px-3 py-2 hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none"
                      >
                        <div className="text-sm font-medium text-slate-900">{displayName(s)}</div>
                        {s.homeroom ? (
                          <div className="text-[11px] text-slate-500">{s.homeroom}</div>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {students.length > filtered.length && q.trim() === '' ? (
                <div className="px-3 py-1.5 text-[10px] text-zinc-400 italic border-t border-zinc-100">
                  Showing first {filtered.length} — type to filter the rest.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {err ? (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-rose-700">
          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
          Couldn&rsquo;t load the student list: {err}
        </div>
      ) : null}
    </div>
  );
}
