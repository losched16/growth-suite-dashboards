'use client';

// Hand-picked bulk-invoice audience: searchable checkbox list of
// active families (with their students for recognizability). Checked
// boxes submit as family_ids[] with the surrounding form; checking any
// box auto-selects the "Pick families" radio so the operator can't
// forget to switch audience modes.

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

export interface PickableFamily {
  id: string;
  label: string;
  students: string;   // "Mia, Noah, Ava"
}

export function FamilyPicker({ families }: { families: PickableFamily[] }) {
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return families;
    return families.filter((f) => f.label.toLowerCase().includes(q) || f.students.toLowerCase().includes(q));
  }, [families, search]);

  function toggle(id: string) {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChecked(next);
    // Flip the audience radio to "pick" so checked boxes always count.
    const radio = document.getElementById('aud-pick') as HTMLInputElement | null;
    if (radio && next.size > 0) radio.checked = true;
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${families.length} families or student names…`}
          className="flex-1 text-sm outline-none"
        />
        <span className="text-xs text-slate-500 whitespace-nowrap">{checked.size} selected</span>
        {checked.size > 0 ? (
          <button type="button" onClick={() => setChecked(new Set())} className="text-xs text-slate-500 hover:underline">
            clear
          </button>
        ) : null}
      </div>
      {/* Checked-but-filtered-out families still submit: keep their
          inputs mounted via hidden inputs. */}
      {[...checked].filter((id) => !visible.some((f) => f.id === id)).map((id) => (
        <input key={id} type="hidden" name="family_ids" value={id} />
      ))}
      <ul className="max-h-64 overflow-y-auto divide-y divide-slate-50">
        {visible.length === 0 ? (
          <li className="px-3 py-3 text-sm text-slate-500 italic">No families match.</li>
        ) : visible.map((f) => (
          <li key={f.id}>
            <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                name="family_ids"
                value={f.id}
                checked={checked.has(f.id)}
                onChange={() => toggle(f.id)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="font-medium text-slate-900">{f.label}</span>
              {f.students ? <span className="text-xs text-slate-500 truncate">— {f.students}</span> : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
