'use client';

// Invoice recipient picker. Two modes:
//   - "Existing family" → the original family dropdown (unchanged path;
//     posts family_id).
//   - "Anyone" → search the school's GHL contacts (typeahead) OR type a
//     name + email by hand. Posts recipient_name + recipient_email
//     (+ recipient_ghl_contact_id when picked from GHL).
//
// The server API accepts EITHER family_id OR recipient_email, so the
// hidden inputs we emit depend on the active mode.

import { useState, useEffect, useRef } from 'react';
import { Search, Loader2, Check, X } from 'lucide-react';

interface FamilyOption { id: string; label: string }
interface GhlContact {
  id: string; name: string; first_name: string; last_name: string; email: string; phone: string;
}
export interface FamilyMember { id: string; name: string }

export function RecipientPicker({
  schoolId, families, defaultFamilyId, studentsByFamily = {}, parentsByFamily = {},
}: {
  schoolId: string;
  families: FamilyOption[];
  defaultFamilyId: string;
  // Per-family active students/parents so the operator can attribute
  // the invoice to a STUDENT and choose which parent receives it.
  studentsByFamily?: Record<string, FamilyMember[]>;
  parentsByFamily?: Record<string, FamilyMember[]>;
}) {
  const [mode, setMode] = useState<'family' | 'anyone'>(defaultFamilyId ? 'family' : 'family');
  const [familyId, setFamilyId] = useState(defaultFamilyId);
  const famStudents = studentsByFamily[familyId] ?? [];
  const famParents = parentsByFamily[familyId] ?? [];

  // "Anyone" state
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<GhlContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<GhlContact | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [ghlContactId, setGhlContactId] = useState('');

  // Debounced GHL typeahead.
  const debTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'anyone') return;
    if (picked) return; // a selection is showing; don't re-search
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    if (debTimer.current) clearTimeout(debTimer.current);
    debTimer.current = setTimeout(async () => {
      setSearching(true); setSearchErr(null);
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/ghl/contact-search?q=${encodeURIComponent(q)}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setSearchErr(j.detail || j.error || 'Search failed'); setResults([]); }
        else setResults(j.contacts ?? []);
      } catch (e) {
        setSearchErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (debTimer.current) clearTimeout(debTimer.current); };
  }, [search, mode, picked, schoolId]);

  function pick(c: GhlContact) {
    setPicked(c);
    setName(c.name);
    setEmail(c.email);
    setGhlContactId(c.id);
    setResults([]);
    setSearch('');
  }
  function clearPick() {
    setPicked(null);
    setName(''); setEmail(''); setGhlContactId('');
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">Bill to</span>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name="recipient_mode" value="family" checked={mode === 'family'} onChange={() => setMode('family')} />
          Existing family
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name="recipient_mode" value="anyone" checked={mode === 'anyone'} onChange={() => setMode('anyone')} />
          Anyone (contact or email)
        </label>
      </div>

      {mode === 'family' ? (
        <>
          <input type="hidden" name="recipient_mode" value="family" />
          <select
            name="family_id"
            value={familyId}
            onChange={(e) => setFamilyId(e.target.value)}
            className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
          >
            <option value="">— select a family —</option>
            {families.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          {familyId && (famStudents.length > 0 || famParents.length > 0) ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">Attribute to student</span>
                <select
                  name="student_id"
                  defaultValue={famStudents.length === 1 ? famStudents[0].id : ''}
                  key={`st-${familyId}`}
                  className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
                >
                  <option value="">Whole family (no specific student)</option>
                  {famStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">Send bill to</span>
                <select
                  name="responsible_parent_id"
                  defaultValue=""
                  key={`pa-${familyId}`}
                  className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
                >
                  <option value="">All parents in family</option>
                  {famParents.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}
                </select>
              </label>
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-2">
          <input type="hidden" name="recipient_mode" value="anyone" />
          <input type="hidden" name="recipient_name" value={name} />
          <input type="hidden" name="recipient_email" value={email} />
          <input type="hidden" name="recipient_ghl_contact_id" value={ghlContactId} />

          {/* GHL typeahead */}
          {!picked ? (
            <div className="relative">
              <div className="flex items-center gap-2 rounded border border-zinc-300 px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-zinc-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search Growth Suite contacts by name or email…"
                  className="flex-1 text-sm outline-none"
                />
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" /> : null}
              </div>
              {results.length > 0 ? (
                <ul className="absolute z-10 mt-1 w-full max-h-60 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg">
                  {results.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => pick(c)} className="w-full px-3 py-2 text-left text-sm hover:bg-emerald-50">
                        <div className="font-medium text-zinc-900">{c.name}</div>
                        <div className="text-xs text-zinc-500">{c.email}{c.phone ? ` · ${c.phone}` : ''}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {searchErr ? <div className="mt-1 text-[11px] text-amber-700">{searchErr} — you can still type a name + email below.</div> : null}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-emerald-600" />
                <span><span className="font-medium text-emerald-900">{picked.name}</span> <span className="text-emerald-700">· {picked.email}</span></span>
              </div>
              <button type="button" onClick={clearPick} className="text-emerald-700 hover:text-emerald-900"><X className="h-4 w-4" /></button>
            </div>
          )}

          {/* Manual entry (always editable — covers contacts not in GHL) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Recipient name</span>
              <input type="text" value={name} onChange={(e) => { setName(e.target.value); }} placeholder="e.g. Clint Smith"
                className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Recipient email *</span>
              <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setGhlContactId(''); }} placeholder="e.g. clint@example.com"
                className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
          <p className="text-[11px] text-zinc-500">
            Pick a Growth Suite contact above, or just type a name + email. The recipient gets a secure pay link — no portal login needed.
          </p>
        </div>
      )}
    </div>
  );
}
