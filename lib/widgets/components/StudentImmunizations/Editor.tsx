'use client';

// Staff dose-entry editor for one student. Renders editable dose dates +
// per-vaccine exemption/immunity flags + the student-level profile
// (certificate on file, all-vaccine exemption, in-process). Saves the
// whole state to /api/school/immunizations/[studentId], then refreshes
// the server-rendered widget so the grid + reports recompute.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Save, Loader2, Check, AlertCircle } from 'lucide-react';
import { VACCINES, type VaccineCode } from '@/lib/immunizations/schedule';
import type { DoseRow, VaccineFlag, ImmunizationProfile } from '@/lib/immunizations/engine';

type Exemption = 'none' | 'medical' | 'religious';
interface FlagState { exemption: Exemption; immunity_documented: boolean; not_required: boolean }
interface DoseState { date: string; na: boolean }

export function ImmunizationEditor({
  studentId, vaccines, initialDoses, initialFlags, initialProfile,
}: {
  studentId: string;
  vaccines: VaccineCode[];
  initialDoses: DoseRow[];
  initialFlags: VaccineFlag[];
  initialProfile: ImmunizationProfile | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [profile, setProfile] = useState({
    certificate_on_file: initialProfile?.certificate_on_file ?? false,
    all_vaccine_exemption: (initialProfile?.all_vaccine_exemption ?? 'none') as Exemption,
    in_process: initialProfile?.in_process ?? false,
    in_process_note: initialProfile?.in_process_note ?? '',
  });

  const [flags, setFlags] = useState<Record<string, FlagState>>(() => {
    const m: Record<string, FlagState> = {};
    for (const v of vaccines) {
      const f = initialFlags.find((x) => x.vaccine_code === v);
      m[v] = { exemption: (f?.exemption ?? 'none') as Exemption, immunity_documented: !!f?.immunity_documented, not_required: !!f?.not_required };
    }
    return m;
  });

  const [doses, setDoses] = useState<Record<string, DoseState>>(() => {
    const m: Record<string, DoseState> = {};
    for (const v of vaccines) {
      for (let n = 1; n <= VACCINES[v].maxDoses; n++) {
        const d = initialDoses.find((x) => x.vaccine_code === v && x.dose_number === n);
        m[`${v}:${n}`] = { date: d?.date_administered ?? '', na: d?.status_override === 'not_applicable' };
      }
    }
    return m;
  });

  function setDose(key: string, patch: Partial<DoseState>) {
    setDoses((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setSaved(false);
  }
  function setFlag(v: string, patch: Partial<FlagState>) {
    setFlags((prev) => ({ ...prev, [v]: { ...prev[v], ...patch } }));
    setSaved(false);
  }

  async function save() {
    setSaving(true); setErr(null); setSaved(false);
    try {
      const payload = {
        profile: {
          certificate_on_file: profile.certificate_on_file,
          all_vaccine_exemption: profile.all_vaccine_exemption,
          in_process: profile.in_process,
          in_process_note: profile.in_process_note || null,
        },
        flags: vaccines.map((v) => ({ vaccine_code: v, ...flags[v] })),
        doses: Object.entries(doses).flatMap(([key, d]) => {
          if (!d.date && !d.na) return [];
          const [vaccine_code, n] = key.split(':');
          return [{ vaccine_code, dose_number: Number(n), date_administered: d.na ? null : (d.date || null), status_override: d.na ? 'not_applicable' : null }];
        }),
      };
      const r = await fetch(`/api/school/immunizations/${studentId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `Save failed (${r.status})`); return; }
      setSaved(true);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Student-level controls */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={profile.certificate_on_file} onChange={(e) => { setProfile((p) => ({ ...p, certificate_on_file: e.target.checked })); setSaved(false); }} className="h-4 w-4 rounded border-slate-300" />
          <span>Certificate of immunization on file</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-600">All-vaccine exemption:</span>
          <select value={profile.all_vaccine_exemption} onChange={(e) => { setProfile((p) => ({ ...p, all_vaccine_exemption: e.target.value as Exemption })); setSaved(false); }} className="rounded border border-slate-300 px-2 py-1 text-sm">
            <option value="none">None</option><option value="medical">Medical</option><option value="religious">Religious</option>
          </select>
        </label>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" checked={profile.in_process} onChange={(e) => { setProfile((p) => ({ ...p, in_process: e.target.checked })); setSaved(false); }} className="h-4 w-4 rounded border-slate-300" />
          <span>In process (physician-approved catch-up schedule on file)</span>
        </label>
        {profile.in_process ? (
          <input type="text" value={profile.in_process_note} onChange={(e) => { setProfile((p) => ({ ...p, in_process_note: e.target.value })); setSaved(false); }} placeholder="Catch-up note (optional)" className="sm:col-span-2 rounded border border-slate-300 px-2 py-1 text-sm" />
        ) : null}
      </div>

      {/* Per-vaccine dose entry */}
      <div className="space-y-2">
        {vaccines.map((v) => {
          const def = VACCINES[v];
          const f = flags[v];
          const disabled = f.exemption !== 'none' || f.not_required;
          return (
            <div key={v} className="rounded-lg border border-slate-200 overflow-hidden">
              <div className="bg-slate-100 px-3 py-1.5 flex items-center justify-between flex-wrap gap-2">
                <span className="text-sm font-medium text-slate-800">{def.label} <span className="text-[10px] text-slate-400">({def.aliases})</span></span>
                <div className="flex items-center gap-3 text-[11px]">
                  <label className="flex items-center gap-1">
                    <span className="text-slate-500">Exempt:</span>
                    <select value={f.exemption} onChange={(e) => setFlag(v, { exemption: e.target.value as Exemption })} className="rounded border border-slate-300 px-1 py-0.5 text-[11px]">
                      <option value="none">—</option><option value="medical">Medical</option><option value="religious">Religious</option>
                    </select>
                  </label>
                  {def.immunityAllowed ? (
                    <label className="flex items-center gap-1" title="Titer / history of disease counts as up to date">
                      <input type="checkbox" checked={f.immunity_documented} onChange={(e) => setFlag(v, { immunity_documented: e.target.checked })} className="h-3.5 w-3.5" />
                      <span className="text-slate-600">Immunity</span>
                    </label>
                  ) : null}
                  <label className="flex items-center gap-1" title="Not required for this child">
                    <input type="checkbox" checked={f.not_required} onChange={(e) => setFlag(v, { not_required: e.target.checked })} className="h-3.5 w-3.5" />
                    <span className="text-slate-600">N/A</span>
                  </label>
                </div>
              </div>
              <div className={`px-3 py-2 flex flex-wrap gap-3 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
                {Array.from({ length: def.maxDoses }, (_, i) => i + 1).map((n) => {
                  const key = `${v}:${n}`;
                  const d = doses[key];
                  return (
                    <div key={n} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-slate-500">Dose {n}</span>
                      <input type="date" value={d.na ? '' : d.date} disabled={d.na} onChange={(e) => setDose(key, { date: e.target.value })} className="rounded border border-slate-300 px-1.5 py-0.5 text-xs disabled:bg-slate-100" />
                      <label className="flex items-center gap-1 text-[10px] text-slate-500">
                        <input type="checkbox" checked={d.na} onChange={(e) => setDose(key, { na: e.target.checked })} className="h-3 w-3" /> N/A
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 sticky bottom-0 bg-white/90 backdrop-blur py-2 border-t border-slate-200">
        <button type="button" onClick={save} disabled={saving || pending}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
          {saving || pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save records
        </button>
        {saved && !err ? <span className="text-sm text-emerald-700 inline-flex items-center gap-1"><Check className="h-4 w-4" /> Saved</span> : null}
        {err ? <span className="text-sm text-rose-700 inline-flex items-center gap-1"><AlertCircle className="h-4 w-4" /> {err}</span> : null}
      </div>
    </div>
  );
}
