'use client';

// Client-side version of the Student Roster list view. Adds inline
// family accordion: click a family name and the row expands below to
// show that family's parents (with mailto + tel links) and siblings
// (other students in the same family). Lazy-loaded via the family-
// detail API so the initial roster render stays snappy.
//
// Server side passes us already-fetched/filtered rows; we just handle
// the click interaction + family-detail fetch.

import { useState, useEffect, useRef } from 'react';
import { AlertTriangle, ChevronRight, ChevronDown, X, Phone, Mail, UserCheck, ShieldAlert, Car, Heart, Stethoscope, DollarSign, Lock } from 'lucide-react';
import type { RosterStudent } from './fetcher';
import type { ColumnKey } from './config';
import { AVAILABLE_COLUMNS } from './config';
import { DocumentsCell } from './DocumentsCell';

interface ParentInfo {
  id: string;
  first_name: string; last_name: string;
  email: string | null; phone: string | null;
  is_primary: boolean;
  // Kiosk check-in PIN — office-viewable copy decrypted server-side.
  pin?: string | null;
  pin_state?: 'visible' | 'set_hidden' | 'none';
  // Inter-parent privacy. School staff (this dashboard) always sees
  // the full record; the flag is shown as a badge so staff know that
  // this parent's info is hidden from the OTHER parents in the same
  // family on the parent portal.
  is_private_from_co_parents?: boolean;
  // Student ids this parent has explicitly opted into. Empty array →
  // "applies to all students in the family" (back-compat default).
  // Used for blended-family rendering — staff can see at a glance
  // "this parent is only the parent of Charlie, not Maddie."
  assigned_student_ids?: string[];
}

interface FamilyStudent {
  id: string;
  first_name: string; last_name: string; preferred_name: string | null;
  date_of_birth: string | null;
  gender: string | null;
  homeroom: string | null;
  program: string | null;
}

interface AuthorizedPickup {
  id: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  notes: string | null;
  added_by_parent: string | null;
}

interface PickupRestriction {
  id: string;
  student_id: string;
  student_display: string;
  person_name: string;
  relationship: string | null;
  reason: string | null;
  notes: string | null;
}

interface HealthProfile {
  student_id: string;
  emergency_contact_name: string | null;
  emergency_contact_relationship: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_alt_phone: string | null;
  primary_doctor_name: string | null;
  primary_doctor_phone: string | null;
  preferred_hospital: string | null;
  health_insurance_provider: string | null;
  health_insurance_policy_number: string | null;
  allergies: string | null;
  current_medications: string | null;
  medical_conditions: string | null;
}

interface TuitionInfo {
  returning_status?: string;
  program_full_text?: string;
  payment_plan?: string;
  discounts_description?: string;
  applying_ed_choice?: string;
  ed_choice_amount_cents?: number;
  base_tuition_cents?: number;
  deposit_cents?: number;
  sibling_discount_cents?: number;
  faculty_discount_cents?: number;
  pif_discount_march_cents?: number;
  pif_discount_june_cents?: number;
  amount_billed_cents?: number;
  anticipated_parent_bill_cents?: number;
  total_invoice_cents?: number;
  total_discounts_cents?: number;
  number_of_payments?: number;
  amount_per_12_payment_cents?: number;
  amount_per_10_payment_cents?: number;
  amount_pay_in_full_cents?: number;
  billed_status?: string;
  deposit_billing_status?: string;
}

interface EnrollmentMeta {
  student_id: string;
  payment_plan: string | null;
  program: string | null;
  hours_of_attendance: string | null;
  days_of_attendance: string[] | null;
  roster_permissions: Record<string, boolean> | null;
  tuition: TuitionInfo | null;
}

interface MedicalForm {
  submission_id: string;
  form_definition_id: string;
  form_display_name: string;
  form_slug: string;
  student_id: string;
  submitted_at: string | null;
  status: string;
  expires_on: string | null;
}

interface PickupPersonManage {
  id: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  active: boolean;
  pin_set: boolean;
  is_temporary: boolean;
}

interface FamilyDetail {
  family: { id: string; display_name: string | null; notes: string | null };
  parents: ParentInfo[];
  students: FamilyStudent[];
  // Family home address (GHL-synced), e.g. "1024 E Frye Road, Phoenix, AZ, 85048".
  address?: string | null;
  authorized_pickups: AuthorizedPickup[];
  // Kiosk pickup-person management rows (incl. deactivated + PIN state).
  pickup_people_manage: PickupPersonManage[];
  pickup_restrictions: PickupRestriction[];
  health_profiles: HealthProfile[];
  enrollment_meta: EnrollmentMeta[];
  medical_forms: MedicalForm[];
  // Self-serve extra rows from the school's GHL data (Customize →
  // Details). Resolved server-side per family.
  extra_attrs: Array<{ attr_key: string; label: string; value: string }>;
}

// Columns whose headers are clickable to sort (server-side via ?sort=&dir=).
const SORTABLE = new Set<ColumnKey>(['student', 'last_name', 'first_name', 'program', 'homeroom', 'schedule', 'status', 'tuition', 'initial_start_date', 'student_id', 'grade_level', 'birth_date', 'lunch']);

// "2021-08-09 00:00:00" / ISO → "Aug 9, 2021". Returns the raw value
// when it isn't a parseable date.
function fmtStartDate(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function StudentTableWithAccordion({
  rows, columns, locationId, documentsAudience = 'all', current = {}, dynamicLabels = {}, detailSections, embedToken,
}: {
  rows: RosterStudent[];
  // Static ColumnKeys plus any catalog attr_keys ('tag', 'cf:…') the
  // school added as columns via the self-serve builder.
  columns: string[];
  locationId: string;
  documentsAudience?: 'teacher' | 'all';
  current?: Record<string, string | undefined>;
  dynamicLabels?: Record<string, string>;
  // Which built-in detail-panel sections render (undefined = all).
  detailSections?: string[];
  // Server-derived embed token — required on every link that opens a
  // NEW TAB (document Open, attendance history). The proxy strips
  // embed_token off the iframe URL, so client-side URL reads miss it.
  embedToken?: string;
}) {
  // Build a header href that toggles asc/desc on the clicked column and
  // preserves all existing URL params (filters, year, view, embed).
  const sortKey = current.sort ?? 'student'; // matches the fetcher's default
  const sortDesc = current.dir === 'desc';
  function sortHref(col: string): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (v && k !== 'sort' && k !== 'dir' && k !== 'page') p.set(k, v);
    p.set('sort', col);
    // toggle direction if already sorting by this column, else asc
    if (sortKey === col && !sortDesc) p.set('dir', 'desc');
    return `?${p.toString()}`;
  }
  // Expanded state is keyed by ROW (student), not family — a family with
  // several kids on the roster would otherwise open its detail panel at
  // EVERY one of their rows at once, visually swallowing unrelated rows
  // in between (Sonia's "why are these students in a box" screenshot).
  const [expanded, setExpanded] = useState<{ row: string; family: string } | null>(null);
  const [details, setDetails] = useState<Record<string, FamilyDetail | 'loading' | { err: string }>>({});
  // Tracks family ids we've started fetching for. Refs are synchronous
  // (unlike functional setState updaters which React 18 may defer to
  // the next render), so this is the right place for an "in-flight"
  // guard. Without this we got the bug where the panel sat on
  // "Loading family detail…" forever — the early-return ran before
  // the updater fired, so no fetch was ever launched.
  const fetchedRef = useRef<Set<string>>(new Set());

  // Fetch family detail on first expand of a given family.
  useEffect(() => {
    if (!expanded) return;
    const targetId = expanded.family;
    if (fetchedRef.current.has(targetId)) return;
    fetchedRef.current.add(targetId);

    let cancelled = false;
    setDetails((d) => ({ ...d, [targetId]: 'loading' }));

    (async () => {
      try {
        const r = await fetch(`/api/school/family/${encodeURIComponent(targetId)}/detail`);
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok || !data.ok) {
          setDetails((d) => ({ ...d, [targetId]: { err: data.error || `HTTP ${r.status}` } }));
          return;
        }
        setDetails((d) => ({
          ...d,
          [targetId]: {
            family: data.family,
            parents: data.parents,
            students: data.students,
            address: data.address ?? null,
            authorized_pickups: data.authorized_pickups ?? [],
            pickup_people_manage: data.pickup_people_manage ?? [],
            pickup_restrictions: data.pickup_restrictions ?? [],
            health_profiles: data.health_profiles ?? [],
            enrollment_meta: data.enrollment_meta ?? [],
            medical_forms: data.medical_forms ?? [],
            extra_attrs: data.extra_attrs ?? [],
          },
        }));
      } catch (e) {
        if (cancelled) return;
        setDetails((d) => ({ ...d, [targetId]: { err: e instanceof Error ? e.message : String(e) } }));
      }
    })();
    return () => { cancelled = true; };
  }, [expanded]);

  if (rows.length === 0) {
    return <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">No students match.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>{columns.map((c) => {
            const label = AVAILABLE_COLUMNS.find((x) => x.key === c)?.label ?? dynamicLabels[c] ?? c;
            // Dynamic (catalog) columns are always sortable.
            const sortable = SORTABLE.has(c as ColumnKey) || c in dynamicLabels;
            if (!sortable) return <th key={c} className="px-3 py-2 font-medium">{label}</th>;
            const active = sortKey === c;
            const arrow = active ? (sortDesc ? ' ↓' : ' ↑') : '';
            return (
              <th key={c} className="px-3 py-2 font-medium">
                <a href={sortHref(c)} className={`inline-flex items-center hover:text-gray-900 ${active ? 'text-gray-900' : ''}`} title={`Sort by ${label}`}>
                  {label}<span className="ml-0.5 text-gray-400">{arrow || ' ↕'}</span>
                </a>
              </th>
            );
          })}</tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((s) => {
            const isOpen = expanded?.row === s.student_id;
            return (
              <RowGroup
                key={s.student_id}
                s={s}
                columns={columns}
                locationId={locationId}
                documentsAudience={documentsAudience}
                isOpen={isOpen}
                detail={isOpen ? details[s.family_id] : undefined}
                onToggle={() => setExpanded(isOpen ? null : { row: s.student_id, family: s.family_id })}
                detailSections={detailSections}
                embedToken={embedToken}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowGroup({
  s, columns, locationId, documentsAudience, isOpen, detail, onToggle, detailSections, embedToken,
}: {
  s: RosterStudent;
  columns: string[];
  locationId: string;
  documentsAudience: 'teacher' | 'all';
  isOpen: boolean;
  detail: FamilyDetail | 'loading' | { err: string } | undefined;
  onToggle: () => void;
  detailSections?: string[];
  embedToken?: string;
}) {
  return (
    <>
      <tr className={`hover:bg-gray-50 ${isOpen ? 'bg-emerald-50/30' : ''}`}>
        {columns.map((c) => (
          <td key={c} className="px-3 py-2 align-top">
            {renderCell(s, c, locationId, isOpen, onToggle, documentsAudience, embedToken)}
          </td>
        ))}
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={columns.length} className="bg-gray-50 border-y border-emerald-200 p-0">
            <FamilyDetailPanel detail={detail} onClose={onToggle} locationId={locationId} sections={detailSections} embedToken={embedToken} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// Render an allergy cell that's smart about three states:
//   - Has real prose ("Eggs, milk and Almonds") — show in red
//   - Legacy "Yes" flag with no detail — show in amber "flagged · no detail"
//   - No allergy or "No"/"None" — show em-dash
// '14:30' (stored curbside time) -> '2:30 pm' for the chip.
function fmtCurbTime(v: string): string {
  const [hh, mm] = v.split(':').map((s) => parseInt(s, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return v;
  const period = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

// Parent kiosk-PIN cell: shows the PIN (decrypted server-side) and
// lets the office SET or CHANGE it when a parent asks — e.g. over the
// phone: "make my PIN 4482". Writes the same hash + lookup + encrypted
// copy the portal writes, so it works at the kiosk immediately and is
// viewable both here and in the parent's own portal.
// Per-parent portal scoping editor (blended families). "All children"
// is the default; restricting a parent limits their PORTAL and KIOSK
// to the checked students only — e.g. Maelynn's biological father sees
// Maelynn, never his co-parent's other kids.
function PortalScopeEditor({ parent: p, kids }: {
  parent: ParentInfo;
  kids: Array<{ id: string; first_name: string; last_name: string; preferred_name: string | null }>;
}) {
  const current = p.assigned_student_ids ?? [];
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set(current));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = (k: { first_name: string; preferred_name: string | null }) => k.preferred_name?.trim() || k.first_name;

  async function save(ids: string[]) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/school/parent/${p.id}/student-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_ids: ids }),
      });
      if (!r.ok) throw new Error((await r.text()) || 'failed');
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
      setBusy(false);
    }
  }

  if (kids.length < 2) return null; // one-kid families have nothing to scope

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className={`text-[10px] ${current.length > 0 ? 'font-semibold text-violet-800' : 'text-slate-500'}`}>
          Portal: {current.length === 0
            ? 'all children'
            : kids.filter((k) => current.includes(k.id)).map(label).join(', ') + ' only'}
        </span>
        <button
          type="button"
          onClick={() => { setChecked(new Set(current)); setEditing(true); }}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
          title="Limit which children this parent can see and act on in the portal and at the kiosk"
        >
          edit
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 flex-wrap rounded border border-violet-200 bg-violet-50/40 px-2 py-1">
      {kids.map((k) => (
        <label key={k.id} className="inline-flex items-center gap-1 text-[11px]">
          <input
            type="checkbox"
            checked={checked.has(k.id)}
            onChange={(e) => {
              const next = new Set(checked);
              if (e.target.checked) next.add(k.id); else next.delete(k.id);
              setChecked(next);
            }}
            className="h-3 w-3 rounded border-violet-300"
          />
          {label(k)}
        </label>
      ))}
      <button type="button" disabled={busy || checked.size === 0}
        onClick={() => save([...checked])}
        title="Restrict this parent to the checked children"
        className="rounded bg-violet-700 px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50">
        Save
      </button>
      <button type="button" disabled={busy} onClick={() => save([])}
        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-600">
        All children
      </button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)}
        className="text-[10px] text-slate-500 underline">
        cancel
      </button>
      {err ? <span className="text-[10px] text-rose-700">{err}</span> : null}
    </span>
  );
}

function ParentPinCell({ familyId, parent: p }: { familyId: string; parent: ParentInfo }) {
  const [state, setState] = useState<{ pinState: string; pin: string | null }>({
    pinState: p.pin_state ?? 'none', pin: p.pin ?? null,
  });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set('parent_id', p.id);
      fd.set('pin', value);
      const r = await fetch(`/api/school/family/${encodeURIComponent(familyId)}/parent-pin`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.detail || j.error || `HTTP ${r.status}`); return; }
      setState({ pinState: 'visible', pin: String(j.pin) });
      setEditing(false); setValue('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {state.pinState === 'visible' && state.pin ? (
        <span className="inline-flex items-center gap-0.5 rounded bg-violet-50 border border-violet-200 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800" title="Kiosk check-in PIN — read it back to the parent if they forget.">
          PIN: <span className="font-mono">{state.pin}</span>
        </span>
      ) : state.pinState === 'set_hidden' ? (
        <span className="text-[11px] text-slate-400 italic" title="Set before PINs became office-viewable. Still works at the kiosk; setting a new one here (or the parent re-saving theirs) makes it viewable.">
          PIN set (not viewable)
        </span>
      ) : (
        <span className="text-[11px] text-slate-400 italic">no check-in PIN set</span>
      )}
      {editing ? (
        <>
          <input
            type="text" inputMode="numeric" autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="4-8 digits"
            className="w-20 rounded border border-violet-300 px-1.5 py-0.5 text-[11px] tracking-widest"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (value.length >= 4) save(); } if (e.key === 'Escape') { setEditing(false); setValue(''); setErr(null); } }}
          />
          <button type="button" disabled={busy || value.length < 4} onClick={save}
            className="rounded bg-violet-700 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => { setEditing(false); setValue(''); setErr(null); }}
            className="text-[10px] text-slate-500 underline">cancel</button>
        </>
      ) : (
        <button type="button" onClick={() => setEditing(true)}
          title="Set or change this parent's kiosk PIN on their behalf"
          className="rounded border border-violet-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-50">
          {state.pinState === 'none' ? 'Set PIN' : 'Change'}
        </button>
      )}
      {err ? <span className="text-[10px] text-rose-700">{err}</span> : null}
    </span>
  );
}

// Office kiosk-pickup-person manager. Parents can't self-add pickup
// people (they email admissions); this is where the office lands those
// requests: add the person, hand the generated PIN back to the family.
// PINs are shown ONCE — after that only "PIN active" is visible.
function PickupPeopleManager({
  familyId, people: initialPeople, students,
}: {
  familyId: string;
  people: PickupPersonManage[];
  students: Array<{ id: string; label: string }>;
}) {
  const [people, setPeople] = useState(initialPeople);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<{ name: string; pin: string } | null>(null);

  async function post(fd: FormData): Promise<Record<string, unknown> | null> {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/school/family/${encodeURIComponent(familyId)}/pickup-persons`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || `HTTP ${r.status}`); return null; }
      return j;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set('action', 'create');
    const j = await post(fd);
    if (!j) return;
    const name = String(fd.get('name') ?? '');
    setPeople((ps) => [...ps, {
      id: String(j.id), name, relationship: String(fd.get('relationship') ?? ''),
      phone: String(fd.get('phone') ?? '') || null, active: true, pin_set: true, is_temporary: false,
    }]);
    setNewPin({ name, pin: String(j.pin) });
    setAdding(false);
    form.reset();
  }

  async function onRowAction(p: PickupPersonManage, action: 'set_pin' | 'deactivate' | 'reactivate') {
    const fd = new FormData();
    fd.set('action', action);
    fd.set('id', p.id);
    const j = await post(fd);
    if (!j) return;
    if (action === 'set_pin') setNewPin({ name: p.name, pin: String(j.pin) });
    setPeople((ps) => ps.map((x) => x.id === p.id
      ? { ...x, active: action === 'deactivate' ? false : action === 'reactivate' ? true : x.active, pin_set: action === 'set_pin' ? true : x.pin_set }
      : x));
  }

  return (
    <div className="mt-2 rounded border border-violet-200 bg-violet-50/30 p-2">
      <div className="text-[10px] uppercase tracking-wide text-violet-800 font-semibold mb-1">
        Kiosk PINs — office managed
      </div>

      {newPin ? (
        <div className="mb-2 rounded border-2 border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          PIN for <strong>{newPin.name}</strong>:{' '}
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-base font-bold">{newPin.pin}</code>{' '}
          — share it with the family now; it won&rsquo;t be shown again.
        </div>
      ) : null}
      {err ? <div className="mb-2 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">{err}</div> : null}

      {people.length === 0 && !adding ? (
        <div className="text-[11px] italic text-slate-500">No kiosk pickup people yet.</div>
      ) : (
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.id} className={`flex flex-wrap items-center justify-between gap-1.5 rounded border bg-white px-2 py-1 text-xs ${p.active ? 'border-slate-200' : 'border-slate-200 opacity-50'}`}>
              <span className="min-w-0">
                <span className={`font-medium ${p.active ? 'text-slate-900' : 'line-through text-slate-500'}`}>{p.name}</span>
                {p.relationship ? <span className="text-slate-500"> · {p.relationship}</span> : null}
                {p.pin_set ? (
                  <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800">PIN active</span>
                ) : (
                  <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold text-gray-600">no PIN</span>
                )}
              </span>
              <span className="flex items-center gap-1">
                {p.active ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => onRowAction(p, 'set_pin')}
                      title="Generate a new PIN (invalidates the old one)"
                      className="rounded border border-violet-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50">
                      New PIN
                    </button>
                    <button type="button" disabled={busy} onClick={() => onRowAction(p, 'deactivate')}
                      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700 disabled:opacity-50">
                      Deactivate
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => onRowAction(p, 'reactivate')}
                    className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                    Reactivate
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form onSubmit={onCreate} className="mt-2 space-y-1.5 rounded border border-violet-200 bg-white p-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <input type="text" name="name" required maxLength={120} placeholder="Full name *"
              className="rounded border border-slate-300 px-2 py-1 text-xs" />
            <input type="text" name="relationship" required maxLength={80} placeholder="Relationship * (e.g. Grandmother)"
              className="rounded border border-slate-300 px-2 py-1 text-xs" />
            <input type="tel" name="phone" maxLength={40} placeholder="Phone (optional)"
              className="rounded border border-slate-300 px-2 py-1 text-xs" />
            <input type="text" name="notes" maxLength={200} placeholder="Notes (optional)"
              className="rounded border border-slate-300 px-2 py-1 text-xs" />
          </div>
          {students.length > 1 ? (
            <div className="text-[10px] text-slate-600">
              Authorized for (none checked = all children):
              <span className="ml-1 inline-flex flex-wrap gap-2">
                {students.map((st) => (
                  <label key={st.id} className="inline-flex items-center gap-1">
                    <input type="checkbox" name="authorized_student_ids" value={st.id} className="h-3 w-3 rounded border-slate-300" />
                    {st.label}
                  </label>
                ))}
              </span>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy}
              className="rounded bg-violet-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
              {busy ? 'Adding…' : 'Add + generate PIN'}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="text-[11px] text-slate-500 underline">cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          className="mt-1.5 rounded border border-violet-300 bg-white px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-50">
          + Add pickup person
        </button>
      )}
    </div>
  );
}

// Attendance cell + admin quick actions. The buttons write an
// admin-attributed attendance event via the existing manual-override
// API — for when a parent can't do kiosk check-in/out themselves.
function AttendanceCell({ s, embedToken }: { s: RosterStudent; embedToken?: string }) {
  const [busy, setBusy] = useState(false);
  // Local status override after an admin action. The old
  // window.location.reload() served the CACHED roster, so the chip
  // looked unchanged and the office kept tapping — one kid collected
  // 13 duplicate check-ins on day one. Updating in place shows the
  // result instantly and removes the reason to re-tap.
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  // Timestamp of the in-place action so the cell shows "in 8:03"
  // immediately — without it, post-tap rows read as bare "Present"
  // until a refresh (the MYHS "after 8:00 it only states present"
  // report) even though the event time was recorded fine.
  const [localAt, setLocalAt] = useState<{ in?: string; out?: string }>({});
  async function act(eventType: 'check_in' | 'check_out') {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('student_id', s.student_id);
      fd.set('event_type', eventType);
      fd.set('notes', eventType === 'check_in' ? 'Admin check-in from roster' : 'Admin check-out from roster');
      const r = await fetch('/api/school/attendance/manual-override', { method: 'POST', body: fd });
      if (!r.ok) throw new Error(await r.text());
      setLocalStatus(eventType === 'check_in' ? 'present' : 'checked_out');
      setLocalAt((prev) => ({ ...prev, [eventType === 'check_in' ? 'in' : 'out']: new Date().toISOString() }));
    } catch {
      // leave status as-is; button re-enables for retry
    } finally {
      setBusy(false);
    }
  }
  const status = localStatus ?? s.attendance_status;
  const tone = status === 'present'      ? 'bg-emerald-100 text-emerald-800'
             : status === 'partial'      ? 'bg-amber-100 text-amber-800'
             : status === 'checked_out'  ? 'bg-blue-100 text-blue-800'
             : status === 'absent'       ? 'bg-rose-100 text-rose-800'
             :                              'bg-gray-100 text-gray-600';
  const label = status === 'not_yet' ? 'Not yet' : status.replace(/_/g, ' ');
  const inAt = s.attendance_check_in_at ?? localAt.in ?? null;
  const outAt = s.attendance_check_out_at ?? localAt.out ?? null;
  return (
    <div>
      <div className="flex items-center gap-1 flex-wrap">
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
          {label}
        </span>
        {s.curbside_today ? (
          <span
            className="inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800"
            title={s.curbside_slot ? `Curbside pickup at ${fmtCurbTime(s.curbside_slot)}` : 'Curbside pickup today'}
          >
            <Car className="h-3 w-3" />
            {s.curbside_slot ? `Curb ${fmtCurbTime(s.curbside_slot)}` : 'Curb'}
          </span>
        ) : null}
      </div>
      {inAt ? (
        <div className="mt-0.5 text-[10px] text-gray-500">
          in {new Date(inAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          {outAt ? ` · out ${new Date(outAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
          {/* Left and came back (any reason) — show the return leg. */}
          {s.attendance_back_in_at && outAt && new Date(s.attendance_back_in_at) > new Date(outAt)
            ? ` · back ${new Date(s.attendance_back_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : ''}
        </div>
      ) : null}
      <div className="mt-1 flex gap-1">
        {status === 'not_yet' || status === 'checked_out' || status === 'absent' ? (
          <button type="button" disabled={busy} onClick={() => act('check_in')}
            title="Admin check-in (writes an audit event with your email)"
            className="rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
            ✓ In
          </button>
        ) : null}
        {status === 'present' || status === 'partial' ? (
          <button type="button" disabled={busy} onClick={() => act('check_out')}
            title="Admin check-out (writes an audit event with your email)"
            className="rounded border border-blue-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50">
            → Out
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => window.open(attendanceHistoryHref(s.student_id, embedToken), '_blank', 'noopener')}
          title="Full check-in/out history for this student, with signatures"
          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-50">
          history
        </button>
      </div>
    </div>
  );
}

// Deep-link to the per-student attendance history page. Auth comes from
// the server-derived embedToken prop — the proxy strips embed_token off
// the iframe URL, so reading window.location.search misses it and the
// new tab lands unauthorized. URL read kept only as a fallback.
function attendanceHistoryHref(studentId: string, embedToken?: string): string {
  const q = new URLSearchParams({ student: studentId });
  const m = window.location.pathname.match(/^\/school\/([^/]+)/);
  const et = embedToken || new URLSearchParams(window.location.search).get('embed_token');
  if (et) q.set('embed_token', et);
  return `/school/${m ? m[1] : ''}/attendance-history?${q.toString()}`;
}

function renderAllergyCell(s: RosterStudent): React.ReactNode {
  if (s.allergy) {
    return <span className="text-rose-700 text-xs whitespace-pre-wrap">{s.allergy}</span>;
  }
  if (s.has_allergy) {
    return <span className="text-amber-700 text-xs italic" title="A flag was set in GHL but no descriptive allergy text is on file. Ask the parent to fill out the OTC Medication or Emergency form.">flagged · no detail</span>;
  }
  return <span className="text-gray-400">—</span>;
}

function renderCell(
  s: RosterStudent,
  col: string,
  locationId: string,
  isOpen: boolean,
  onToggleFamily: () => void,
  documentsAudience: 'teacher' | 'all' = 'all',
  embedToken?: string,
): React.ReactNode {
  // Dynamic (catalog) column: render the resolved display value.
  if (s.dynamic && s.dynamic[col] !== undefined) {
    return <span className="text-gray-700 text-xs whitespace-pre-wrap">{s.dynamic[col]}</span>;
  }
  switch (col as ColumnKey) {
    case 'student':
      return (
        <span className="font-medium text-gray-900">
          {s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name} {s.last_name}
          {s.has_allergy ? <AlertTriangle className="ml-1 inline h-3 w-3 text-rose-600" /> : null}
          {s.status === 'withdrawn' ? (
            <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 align-middle">
              Withdrawn
            </span>
          ) : s.status === 'on_hold' ? (
            <span className="ml-1.5 rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700 align-middle">
              On hold
            </span>
          ) : s.status === 'alumni' ? (
            <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 align-middle">
              Alumni
            </span>
          ) : s.status === 'pending' ? (
            <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 align-middle">
              Pending
            </span>
          ) : null}
        </span>
      );
    case 'last_name': return <span className="font-medium text-gray-900">{s.last_name}</span>;
    case 'first_name':
      return (
        <span className="font-medium text-gray-900">
          {s.preferred_name ? `${s.preferred_name} (${s.first_name})` : s.first_name}
          {s.has_allergy ? <AlertTriangle className="ml-1 inline h-3 w-3 text-rose-600" /> : null}
        </span>
      );
    case 'gender_age': return <span className="text-gray-700">{(s.gender ?? '—')} · {ageFrom(s.date_of_birth)}</span>;
    case 'birth_date': return s.date_of_birth
      ? <span className="text-gray-700 tabular-nums whitespace-nowrap">{new Date(s.date_of_birth).toLocaleDateString('en-US', { timeZone: 'UTC' })}</span>
      : <span className="text-gray-300">—</span>;
    case 'age_aug1': return <span className="text-gray-700 tabular-nums">{s.age_as_of_aug1 || '—'}</span>;
    case 'age_jan1': return <span className="text-gray-700 tabular-nums">{s.age_as_of_jan1 || '—'}</span>;
    case 'age_today': return <span className="text-gray-700 tabular-nums">{s.age_as_of_today || '—'}</span>;
    case 'program': return <span className="text-gray-700">{s.program ?? s.classroom_name ?? '—'}</span>;
    case 'homeroom': return <span className="text-gray-700">{s.homeroom ?? s.classroom_name ?? '—'}</span>;
    case 'lead_teacher': return <span className="text-gray-700">{s.lead_teacher_name ?? '—'}</span>;
    case 'schedule': return <span className="text-gray-700">{s.schedule ?? '—'}</span>;
    case 'initial_start_date': return <span className="text-gray-700 tabular-nums whitespace-nowrap">{fmtStartDate(s.initial_start_date)}</span>;
    case 'student_id': return s.student_id_number ? <span className="text-gray-700 tabular-nums">{s.student_id_number}</span> : <span className="text-gray-300">—</span>;
    case 'grade_level': return s.grade_level ? <span className="text-gray-700">{s.grade_level}</span> : <span className="text-gray-300">—</span>;
    case 'tuition': {
      if (!s.tuition) return <span className="text-gray-400">—</span>;
      const m = s.tuition.match(/\$[\d,]+(?:\.\d{2})?/);
      const display = m ? m[0] : (/^\d+(\.\d+)?$/.test(s.tuition) ? `$${Number(s.tuition).toLocaleString()}` : s.tuition);
      return <span className="text-gray-700 tabular-nums" title={s.tuition}>{display}</span>;
    }
    case 'status':
      return s.status ? (
        <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
          {s.status.replace(/_/g, ' ')}
        </span>
      ) : <span className="text-gray-400">—</span>;
    case 'allergy': return renderAllergyCell(s);
    case 'special_instructions': return s.special_instructions
      ? <span className="text-slate-800 text-xs whitespace-pre-wrap">{s.special_instructions}</span>
      : <span className="text-gray-400">—</span>;
    case 'iep_504': {
      const tags = [];
      if (s.iep && s.iep.toLowerCase() !== 'no') tags.push('IEP');
      if (s.five04_plan && s.five04_plan.toLowerCase() !== 'no') tags.push('504');
      const hasDoc = s.iep_documents_count > 0;
      if (tags.length === 0 && !hasDoc) return <span className="text-gray-400">—</span>;
      return (
        <span className="inline-flex items-center gap-1">
          {tags.length > 0 ? (
            <span className="inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-800">{tags.join('/')}</span>
          ) : null}
          {hasDoc ? (
            <span
              className="inline-block rounded bg-violet-50 border border-violet-300 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-800"
              title={`${s.iep_documents_count} IEP/504 document(s) uploaded — open the Documents column to view`}
            >
              📄 doc
            </span>
          ) : null}
        </span>
      );
    }
    case 'address':
      return s.address
        ? <span className="text-gray-700">{s.address}</span>
        : <span className="text-gray-400">—</span>;
    case 'family':
      return (
        <button
          type="button"
          onClick={onToggleFamily}
          className={`inline-flex items-center gap-1 text-left ${isOpen ? 'text-emerald-900 font-semibold' : 'text-emerald-700'} hover:underline`}
        >
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {s.family_display_name ?? `${s.last_name} Family`}
        </button>
      );
    case 'documents':
      return (
        <DocumentsCell
          studentId={s.student_id}
          studentDisplay={`${s.preferred_name || s.first_name} ${s.last_name}`}
          initialCount={s.documents_count}
          audience={documentsAudience}
          embedToken={embedToken}
        />
      );
    case 'lunch': {
      // Compact pill: vegan/vegetarian/nonveg get color codes; declined
      // is gray; null is em-dash. Show the raw label as a tooltip so
      // teachers can see the full DonorPerfect-style string on hover.
      if (!s.lunch) return <span className="text-gray-400">—</span>;
      const lower = s.lunch.toLowerCase();
      const declined = lower.includes('decline');
      const tone = declined ? 'bg-gray-100 text-gray-600'
        : lower.includes('vegan')      ? 'bg-emerald-100 text-emerald-800'
        : lower.includes('nonveg')     ? 'bg-amber-100 text-amber-800'
        : lower.includes('vegetarian') ? 'bg-emerald-100 text-emerald-800'
        :                                 'bg-orange-100 text-orange-800';
      const short = declined ? 'Declined'
        : lower.includes('vegan')      ? 'Vegan'
        : lower.includes('nonveg')     ? 'Non-veg'
        : lower.includes('vegetarian') ? 'Vegetarian'
        :                                 'Lunch';
      return (
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
          title={s.lunch}
        >
          {short}
        </span>
      );
    }
    case 're_enrolled': {
      return s.re_enrolled
        ? <span className="inline-block rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Re-enrolled</span>
        : <span className="text-gray-400">—</span>;
    }
    case 'attendance_notes': {
      // Substantive notes left during today's check-in. Surfaces things
      // like "ate breakfast late" / "needs nap by 10:30" without making
      // the teacher click into the attendance dashboard.
      const n = s.attendance_notes;
      if (!n) return <span className="text-gray-400">—</span>;
      return (
        <span
          className="inline-block rounded bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] text-amber-900 whitespace-pre-wrap"
          title={n}
        >
          {n.length > 80 ? `${n.slice(0, 80).trim()}…` : n}
        </span>
      );
    }
    case 'pickup_restrictions': {
      // People who are NOT authorized to pick up this kid. Loud red
      // styling — a teacher at the door scanning this column needs to
      // see it instantly. Each restricted person becomes a chip; the
      // reason is shown as a tooltip so the column doesn't get cramped.
      const list = s.pickup_restrictions;
      if (!list || list.length === 0) return <span className="text-gray-400">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {list.map((r, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-900"
              title={r.reason ? `Reason: ${r.reason}` : 'No reason on file'}
            >
              <ShieldAlert className="h-2.5 w-2.5" />
              {r.name}
            </span>
          ))}
        </div>
      );
    }
    case 'attendance': return <AttendanceCell s={s} embedToken={embedToken} />;
  }
  // Dynamic column with no value for this student, or unknown key —
  // render an em-dash so the table stays aligned.
  if (col.startsWith('cf:') || col === 'tag' || col === 'opp_stage' || col === 'opp_status' || col === 'pipeline') {
    return <span className="text-gray-400">—</span>;
  }
  void locationId;
  return null;
}

function FamilyDetailPanel({
  detail, onClose, locationId, sections, embedToken,
}: {
  detail: FamilyDetail | 'loading' | { err: string } | undefined;
  onClose: () => void;
  locationId: string;
  // Built-in sections to render. undefined = all (back-compat for
  // schools that never customized the dropdown).
  sections?: string[];
  embedToken?: string;
}) {
  const show = (key: string) => !sections || sections.includes(key);
  return (
    <div className="px-6 py-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wide text-emerald-800 font-semibold">
          Family detail
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {detail === undefined || detail === 'loading' ? (
        <div className="text-sm italic text-slate-500">Loading family detail…</div>
      ) : 'err' in detail ? (
        <div className="text-sm text-rose-700">Couldn&rsquo;t load family: {detail.err}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          {show('parents') ? <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Parents ({detail.parents.length})
            </div>
            {detail.address ? (
              <div className="mb-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800">
                <span className="font-semibold">🏠 Home address:</span> {detail.address}
              </div>
            ) : null}
            {detail.parents.length === 0 ? (
              <div className="text-xs italic text-slate-500">No parent records on file.</div>
            ) : (
              <ul className="space-y-2">
                {detail.parents.map((p) => (
                  <li key={p.id} className="rounded border border-slate-200 bg-white p-2">
                    <div className="text-sm font-medium text-slate-900">
                      {p.first_name} {p.last_name}
                      {p.is_primary ? (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-800">
                          primary
                        </span>
                      ) : null}
                      {p.is_private_from_co_parents ? (
                        <span
                          className="ml-2 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
                          title="Marked their info private from co-parents. School staff (you) still see the full record."
                        >
                          <Lock className="h-2.5 w-2.5" /> private from co-parent
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      {p.email ? (
                        <a href={`mailto:${p.email}`} className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
                          <Mail className="h-3 w-3" />{p.email}
                        </a>
                      ) : null}
                      {p.phone ? (
                        <a href={`tel:${p.phone}`} className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
                          <Phone className="h-3 w-3" />{p.phone}
                        </a>
                      ) : null}
                      <ParentPinCell familyId={detail.family.id} parent={p} />
                      {p.email && embedToken ? (
                        // Per-parent portal impersonation — split/married
                        // co-parents each have their OWN portal login, so
                        // "View as parent" must exist per parent, not just
                        // for the primary ("I can only login as Phillip
                        // but not Capri").
                        <a
                          href={`/api/school/family/${detail.family.id}/view-as-parent?embed_token=${encodeURIComponent(embedToken)}&parent_id=${encodeURIComponent(p.id)}`}
                          target="_blank" rel="noopener"
                          className="inline-flex items-center gap-0.5 rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50"
                          title={`Open the parent portal logged in as ${p.first_name}`}
                        >
                          view {p.first_name}&rsquo;s portal ↗
                        </a>
                      ) : null}
                      {!p.email && !p.phone ? (
                        <span className="text-slate-400 italic">no contact info on file</span>
                      ) : null}
                      <PortalScopeEditor parent={p} kids={detail.students} />
                    </div>
                    {/* Per-student assignment summary. Only render when the
                        parent has explicitly scoped to a subset — the
                        default "all kids" is implicit and shouldn't add
                        visual noise. */}
                    {p.assigned_student_ids && p.assigned_student_ids.length > 0 ? (
                      <div className="mt-1 text-[11px] text-slate-600">
                        <span className="font-medium">Parent of:</span>{' '}
                        {p.assigned_student_ids
                          .map((sid) => {
                            const child = detail.students.find((s) => s.id === sid);
                            if (!child) return null;
                            return child.preferred_name || child.first_name;
                          })
                          .filter(Boolean)
                          .join(', ')}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div> : null}

          {show('students') ? <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-2">
              Students in family ({detail.students.length})
            </div>
            <ul className="space-y-1.5">
              {detail.students.map((st) => (
                <li key={st.id} className="rounded border border-slate-200 bg-white px-2 py-1.5 text-sm">
                  <div className="font-medium text-slate-900">
                    {st.preferred_name || st.first_name} {st.last_name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {[
                      st.gender,
                      ageFrom(st.date_of_birth),
                      st.homeroom,
                      st.program,
                    ].filter(Boolean).join(' · ') || '—'}
                  </div>
                </li>
              ))}
            </ul>
          </div> : null}

          {/* Authorized pickup — who CAN collect the kids in this family.
              Aggregated across every parent in the family (dedup by name
              + phone in the API). Empty-state still renders so a teacher
              never wonders "did this section just not load?" */}
          {show('authorized_pickups') ? <div>
            <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-2 flex items-center gap-1">
              <UserCheck className="h-3 w-3" />
              Authorized for pickup ({detail.authorized_pickups.length})
            </div>
            {detail.authorized_pickups.length === 0 ? (
              <div className="text-xs italic text-slate-400">
                No additional pickup people on file.
                <div className="mt-0.5 text-[10px]">Parents are implicitly authorized.</div>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {detail.authorized_pickups.map((a) => (
                  <li key={a.id} className="rounded border border-emerald-200 bg-emerald-50/30 px-2 py-1.5 text-sm">
                    <div className="font-medium text-slate-900">{a.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-700">
                      {a.relationship ? <span>{a.relationship}</span> : null}
                      {a.phone ? (
                        <a href={`tel:${a.phone}`} className="inline-flex items-center gap-0.5 text-blue-600 hover:underline">
                          <Phone className="h-3 w-3" />{a.phone}
                        </a>
                      ) : null}
                    </div>
                    {a.notes ? <div className="mt-0.5 text-[11px] text-slate-500">{a.notes}</div> : null}
                  </li>
                ))}
              </ul>
            )}
            <PickupPeopleManager
              familyId={detail.family.id}
              people={detail.pickup_people_manage}
              students={detail.students.map((st) => ({ id: st.id, label: `${st.preferred_name?.trim() || st.first_name} ${st.last_name}`.trim() }))}
            />
          </div> : null}

          {/* Unauthorized pickup — who CANNOT collect this family's kids.
              Per-student because restrictions can target a specific child
              (custody arrangements, etc.). Sensitive — visually
              distinguished from the safe sections. */}
          {show('pickup_restrictions') ? <div>
            <div className="text-[10px] uppercase tracking-wide text-rose-700 font-semibold mb-2 flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" />
              NOT authorized for pickup ({detail.pickup_restrictions.length})
            </div>
            {detail.pickup_restrictions.length === 0 ? (
              <div className="text-xs italic text-slate-400">No restrictions on file.</div>
            ) : (
              <ul className="space-y-1.5">
                {detail.pickup_restrictions.map((r) => (
                  <li key={r.id} className="rounded border-2 border-rose-300 bg-rose-50/40 px-2 py-1.5 text-sm">
                    <div className="font-semibold text-rose-900">
                      <ShieldAlert className="inline h-3 w-3 mr-1" />
                      {r.person_name}
                    </div>
                    <div className="mt-0.5 text-[11px] text-rose-900">
                      <span className="font-semibold">For:</span> {r.student_display}
                      {r.relationship ? <span> · {r.relationship}</span> : null}
                    </div>
                    {r.reason ? <div className="mt-0.5 text-[11px] text-rose-800"><span className="font-semibold">Reason:</span> {r.reason}</div> : null}
                    {r.notes ? <div className="mt-0.5 text-[11px] text-rose-700">{r.notes}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </div> : null}

          {/* Self-serve extras — GHL data the school added via
              Customize → Details. Family-level (resolved across the
              family's linked contacts). */}
          {(detail.extra_attrs ?? []).length > 0 ? (
            <div className="md:col-span-2">
              <div className="text-[10px] uppercase tracking-wide text-blue-700 font-semibold mb-2">
                More from Growth Suite
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
                {detail.extra_attrs.map((a) => (
                  <div key={a.attr_key} className="rounded border border-blue-100 bg-blue-50/30 px-2 py-1.5">
                    <dt className="text-[10px] uppercase tracking-wide text-slate-500">{a.label}</dt>
                    <dd className="text-sm text-slate-900 whitespace-pre-wrap break-words">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      )}

      {/* Per-student health + operations cards. Each card stacks the
          medical data (allergies, meds, conditions, doctor, hospital,
          insurance, EC #1) with the operational data (program,
          payment plan, attendance days, roster permissions). One card
          per student in the family so a teacher viewing a sibling
          group sees who has what allergy / who's on which payment
          plan at a glance. Only renders when there's a matched health
          or enrollment-meta row for a student — older families
          without Final Forms data won't see an empty card. */}
      {(show('per_student') && detail !== undefined && detail !== 'loading' && !('err' in detail)
        && (detail.health_profiles.length > 0 || detail.enrollment_meta.length > 0)) ? (
        <div className="mt-4 border-t border-emerald-100 pt-3">
          <div className="text-[11px] uppercase tracking-wide text-emerald-800 font-semibold mb-2">
            Per-student detail
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {detail.students.map((st) => {
              const hp = detail.health_profiles.find((h) => h.student_id === st.id);
              const em = detail.enrollment_meta.find((m) => m.student_id === st.id);
              const medForms = (detail.medical_forms ?? []).filter((f) => f.student_id === st.id);
              if (!hp && !em && medForms.length === 0) return null;
              const stDisplay = st.preferred_name || st.first_name;
              return (
                <StudentDetailCard
                  key={st.id}
                  name={`${stDisplay} ${st.last_name}`}
                  hp={hp}
                  em={em}
                  medicalForms={medForms}
                  locationId={locationId}
                  showTuition={show('tuition')}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StudentDetailCard({
  name, hp, em, medicalForms, locationId, showTuition = true,
}: {
  name: string;
  hp: HealthProfile | undefined;
  em: EnrollmentMeta | undefined;
  medicalForms: MedicalForm[];
  locationId: string;
  // Off on teacher-facing dashboards — hides the payment plan line and
  // the tuition/discount breakdown (sensitive financial info).
  showTuition?: boolean;
}) {
  // Render an allergy as a red-tagged callout vs a benign "None on file"
  // — same logic the roster uses for its allergy badge.
  const hasAllergy = hp?.allergies && !['no', 'none', 'n/a', 'na', ''].includes(hp.allergies.trim().toLowerCase());
  const hasMeds    = hp?.current_medications && !['no', 'none', 'n/a', 'na', ''].includes(hp.current_medications.trim().toLowerCase());
  const hasCond    = hp?.medical_conditions && !['no', 'none', 'n/a', 'na', ''].includes(hp.medical_conditions.trim().toLowerCase());

  const rosterPermLabels: Array<[keyof NonNullable<EnrollmentMeta['roster_permissions']>, string]> = [
    ['parent_name', 'parent name'],
    ['child_name', "child's name"],
    ['email', 'email'],
    ['cell_phone', 'cell phone'],
    ['home_phone', 'home phone'],
    ['work_phone', 'work phone'],
    ['address', 'address'],
  ];
  const rosterChecked = em?.roster_permissions
    ? rosterPermLabels.filter(([k]) => em.roster_permissions![k] === true).map(([, label]) => label)
    : [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-900">
        {name}
      </div>
      <div className="p-3 space-y-2.5">
        {/* Medical — high signal, top of card */}
        {hp ? (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rose-700 font-semibold flex items-center gap-1">
              <Heart className="h-3 w-3" /> Medical
            </div>
            {hasAllergy ? (
              <div className="rounded border border-rose-200 bg-rose-50/60 px-2 py-1 text-xs">
                <span className="font-semibold text-rose-900">Allergies: </span>
                <span className="text-rose-900">{hp.allergies}</span>
              </div>
            ) : <div className="text-[11px] text-slate-500"><span className="font-semibold">Allergies:</span> none on file</div>}
            {hasMeds ? (
              <div className="rounded border border-amber-200 bg-amber-50/60 px-2 py-1 text-xs">
                <span className="font-semibold text-amber-900">Current medications: </span>
                <span className="text-amber-900 whitespace-pre-wrap">{hp.current_medications}</span>
              </div>
            ) : null}
            {hasCond ? (
              <div className="rounded border border-amber-200 bg-amber-50/30 px-2 py-1 text-xs">
                <span className="font-semibold text-amber-900">Medical conditions: </span>
                <span className="text-amber-900">{hp.medical_conditions}</span>
              </div>
            ) : null}
            {/* Providers — compact grid */}
            {(hp.primary_doctor_name || hp.preferred_hospital || hp.health_insurance_provider) ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-700 pt-1">
                {hp.primary_doctor_name ? (
                  <div>
                    <Stethoscope className="inline h-3 w-3 mr-0.5 text-slate-400" />
                    <span className="font-medium">Dr.</span> {hp.primary_doctor_name}
                    {hp.primary_doctor_phone ? <> · <a href={`tel:${hp.primary_doctor_phone}`} className="text-blue-600 hover:underline">{hp.primary_doctor_phone}</a></> : null}
                  </div>
                ) : null}
                {hp.preferred_hospital ? (
                  <div><span className="font-medium">Hospital:</span> {hp.preferred_hospital}</div>
                ) : null}
                {hp.health_insurance_provider ? (
                  <div><span className="font-medium">Insurance:</span> {hp.health_insurance_provider}
                    {hp.health_insurance_policy_number ? <span className="text-slate-500"> (#{hp.health_insurance_policy_number})</span> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Emergency contact #1 — EC2/EC3 are surfaced in the
                family-wide Authorized pickup list. */}
            {hp.emergency_contact_name ? (
              <div className="rounded border border-emerald-200 bg-emerald-50/40 px-2 py-1 text-xs">
                <span className="font-semibold text-emerald-900">Primary emergency contact: </span>
                <span className="text-slate-900">{hp.emergency_contact_name}</span>
                {hp.emergency_contact_relationship ? <span className="text-slate-600"> ({hp.emergency_contact_relationship})</span> : null}
                {hp.emergency_contact_phone ? <> · <a href={`tel:${hp.emergency_contact_phone}`} className="text-blue-600 hover:underline">{hp.emergency_contact_phone}</a></> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Medication-related forms on file. Surfaces every submission
            categorized 'medical' so the office can see, in a reaction,
            exactly which forms are authorized + what's expiring. Each
            row deep-links to the submission so admin can pull the full
            response (med name, dose, route, prescriber). */}
        {medicalForms.length > 0 ? (
          <div className="pt-2 border-t border-slate-100 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-rose-700 font-semibold flex items-center gap-1">
              <Heart className="h-3 w-3" /> Medication-related forms on file
            </div>
            <ul className="space-y-1">
              {medicalForms.map((f) => {
                const sub = f.submitted_at ? new Date(f.submitted_at) : null;
                const exp = f.expires_on ? new Date(f.expires_on) : null;
                const now = new Date();
                const expiresSoon = exp && exp.getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000 && exp.getTime() > now.getTime();
                const expired = exp && exp.getTime() < now.getTime();
                return (
                  <li
                    key={f.submission_id}
                    className={`rounded border px-2 py-1 text-[11px] ${
                      expired ? 'border-rose-300 bg-rose-50' :
                      expiresSoon ? 'border-amber-300 bg-amber-50' :
                      'border-rose-100 bg-rose-50/40'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                      <a
                        href={`/school/${locationId}/forms/${f.form_definition_id}/submissions/${f.submission_id}`}
                        className="font-semibold text-rose-900 hover:underline"
                      >
                        {f.form_display_name}
                      </a>
                      {expired ? (
                        <span className="rounded bg-rose-200 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-rose-900">
                          Expired
                        </span>
                      ) : expiresSoon ? (
                        <span className="rounded bg-amber-200 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-amber-900">
                          Expires soon
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-slate-600 flex flex-wrap gap-x-2">
                      {sub ? <span>Submitted {sub.toLocaleDateString()}</span> : null}
                      {exp ? <span>· Expires {exp.toLocaleDateString()}</span> : null}
                      <span className="text-slate-400">· {f.form_slug}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* Operations — payment, attendance days, roster opt-ins */}
        {em ? (
          <div className="pt-2 border-t border-slate-100 space-y-1 text-[11px] text-slate-700">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-0.5">
              Enrollment
            </div>
            {em.program ? <div><span className="font-medium">Program:</span> {em.program}</div> : null}
            {showTuition && em.payment_plan ? <div><span className="font-medium">Payment plan:</span> {em.payment_plan}</div> : null}
            {em.hours_of_attendance ? <div><span className="font-medium">Hours:</span> {em.hours_of_attendance}</div> : null}
            {em.days_of_attendance && em.days_of_attendance.length > 0 ? (
              <div>
                <span className="font-medium">Days:</span>{' '}
                {em.days_of_attendance.join(', ')}
              </div>
            ) : null}
            {em.roster_permissions ? (
              <div>
                <span className="font-medium">Roster opt-in:</span>{' '}
                {rosterChecked.length === 0
                  ? <span className="text-slate-500 italic">opted out of all</span>
                  : rosterChecked.join(', ')}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Tuition / billing — sensitive; gated off on teacher dashboards */}
        {showTuition && em?.tuition ? <TuitionBlock t={em.tuition} /> : null}
      </div>
    </div>
  );
}

function fmtCents(c: number | undefined | null): string {
  if (c == null) return '—';
  const dollars = c / 100;
  const sign = dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TuitionBlock({ t }: { t: TuitionInfo }) {
  // Show the headline number (what the parent is actually being billed)
  // plus a compact breakdown of discounts. If a per-period payment
  // amount is set we surface "$X / 12 payments" so a teacher reviewing
  // can answer "is the payment plan being honored?" without opening
  // billing.
  const hasFigures =
    t.base_tuition_cents != null
    || t.amount_billed_cents != null
    || t.total_invoice_cents != null
    || t.anticipated_parent_bill_cents != null;
  if (!hasFigures && !t.payment_plan) return null;

  const headline =
    t.anticipated_parent_bill_cents ?? t.amount_billed_cents ?? t.total_invoice_cents ?? null;
  const perPayment =
    t.amount_per_12_payment_cents ?? t.amount_per_10_payment_cents ?? t.amount_pay_in_full_cents ?? null;

  return (
    <div className="pt-2 border-t border-slate-100 space-y-1 text-[11px] text-slate-700">
      <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-0.5 flex items-center gap-1">
        <DollarSign className="h-3 w-3" /> Tuition (2026-27)
      </div>
      {headline != null ? (
        <div className="text-sm font-semibold text-slate-900">
          {fmtCents(headline)}
          <span className="ml-2 text-[10px] font-normal text-slate-500">
            parent portion
          </span>
        </div>
      ) : null}
      {t.payment_plan ? <div><span className="font-medium">Plan:</span> {t.payment_plan}</div> : null}
      {perPayment != null && t.number_of_payments != null && t.number_of_payments > 1 ? (
        <div>
          <span className="font-medium">{fmtCents(perPayment)}</span>{' '}
          × {t.number_of_payments} payments
        </div>
      ) : null}
      {t.base_tuition_cents != null ? (
        <div className="grid grid-cols-2 gap-x-3 pt-1">
          <div><span className="font-medium">Base tuition:</span> {fmtCents(t.base_tuition_cents)}</div>
          {t.deposit_cents ? <div><span className="font-medium">Deposit:</span> {fmtCents(t.deposit_cents)}</div> : null}
          {t.sibling_discount_cents ? (
            <div className="text-blue-700">
              <span className="font-medium">Sibling 10%:</span> {fmtCents(t.sibling_discount_cents)}
            </div>
          ) : null}
          {t.faculty_discount_cents ? (
            <div className="text-blue-700">
              <span className="font-medium">Faculty:</span> {fmtCents(t.faculty_discount_cents)}
            </div>
          ) : null}
          {t.pif_discount_march_cents || t.pif_discount_june_cents ? (
            <div className="text-blue-700">
              <span className="font-medium">PIF discount:</span>{' '}
              {fmtCents((t.pif_discount_march_cents ?? 0) + (t.pif_discount_june_cents ?? 0))}
            </div>
          ) : null}
          {t.ed_choice_amount_cents ? (
            <div className="text-emerald-700">
              <span className="font-medium">Ed Choice voucher:</span> {fmtCents(t.ed_choice_amount_cents)}
            </div>
          ) : null}
        </div>
      ) : null}
      {t.billed_status ? (
        <div className="pt-1">
          <span className={`inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            t.billed_status.toLowerCase() === 'billed'
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-amber-100 text-amber-800'
          }`}>
            {t.billed_status}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ageFrom(dob: string | null): string {
  if (!dob) return '—';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let yrs = now.getFullYear() - d.getFullYear();
  let mos = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) mos--;
  if (mos < 0) { yrs--; mos += 12; }
  if (yrs >= 1) return `${yrs}y ${Math.max(0, mos)}m`;
  return `${Math.max(0, mos)}m`;
}
