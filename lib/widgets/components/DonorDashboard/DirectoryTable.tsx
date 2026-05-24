'use client';

// DG-style accordion directory for donors. Click row → expands inline
// panel showing bio + full gift history. One row open at a time.

import { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, ArrowUpDown, ChevronUp } from 'lucide-react';
import type { DonorRow } from './fetcher';
import type { WidgetSearchParams } from '@/lib/widgets/types';

type SortKey = 'name' | 'lifetime' | 'ytd' | 'last_gift';

interface Props {
  rows: DonorRow[];
  current: WidgetSearchParams;
  locationId: string;
  crmAppBase: string;
}

const EMDASH = '—';

export function DirectoryTable({ rows, current, locationId, crmAppBase }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No donors match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />
            <th className="px-3 py-2 font-medium">
              <SortHeader label="Donor" sortKey="name" current={current} />
            </th>
            <th className="px-3 py-2 font-medium">Contact</th>
            <th className="px-3 py-2 font-medium">Segment</th>
            <th className="px-3 py-2 font-medium text-right">
              <SortHeader label="YTD" sortKey="ytd" current={current} align="right" />
            </th>
            <th className="px-3 py-2 font-medium text-right">
              <SortHeader label="Lifetime" sortKey="lifetime" current={current} align="right" />
            </th>
            <th className="px-3 py-2 font-medium text-right">Gifts</th>
            <th className="px-3 py-2 font-medium">
              <SortHeader label="Last gift" sortKey="last_gift" current={current} />
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((d) => {
            const open = expanded === d.id;
            return (
              <DonorRowView
                key={d.id}
                donor={d}
                expanded={open}
                onToggle={() => setExpanded(open ? null : d.id)}
                locationId={locationId}
                crmAppBase={crmAppBase}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DonorRowView({
  donor: d,
  expanded,
  onToggle,
  locationId,
  crmAppBase,
}: {
  donor: DonorRow;
  expanded: boolean;
  onToggle: () => void;
  locationId: string;
  crmAppBase: string;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer ${expanded ? 'bg-emerald-50/50' : 'hover:bg-gray-50'}`}
      >
        <td className="px-2 py-2 align-top text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2 align-top">
          <div className="font-medium text-gray-900">{d.full_name}</div>
          {d.org_rec === 'Y' ? (
            <span className="text-[10px] uppercase tracking-wide text-amber-700 bg-amber-50 px-1 rounded">Organization</span>
          ) : null}
          {d.tags.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-0.5">
              {d.tags.map((t) => (
                <span key={t} className="text-[10px] bg-emerald-50 text-emerald-700 px-1 rounded">
                  {t.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top text-xs text-gray-600">
          {d.email ? <div className="truncate max-w-[18ch]">{d.email}</div> : null}
          {d.phone ? <div>{d.phone}</div> : null}
          {d.city ? <div className="text-gray-500">{d.city}{d.state ? `, ${d.state}` : ''}</div> : null}
        </td>
        <td className="px-3 py-2 align-top text-xs">
          {d.inferred_segment ? (
            <span className={segmentBadgeClass(d.inferred_segment)}>
              {d.inferred_segment.replace(/_/g, ' ')}
            </span>
          ) : <span className="text-gray-400">{EMDASH}</span>}
          {d.match_method && d.match_method !== 'unmatched' ? (
            <div className="text-[10px] text-emerald-700 mt-0.5">match: {d.match_method}</div>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top text-right tabular-nums">
          {d.ytd_school_year > 0 ? fmtMoney(d.ytd_school_year) : <span className="text-gray-400">{EMDASH}</span>}
        </td>
        <td className="px-3 py-2 align-top text-right tabular-nums font-medium text-gray-900">
          {d.gift_total > 0 ? fmtMoney(d.gift_total) : <span className="text-gray-400">{EMDASH}</span>}
        </td>
        <td className="px-3 py-2 align-top text-right tabular-nums">{d.gift_count}</td>
        <td className="px-3 py-2 align-top text-xs text-gray-600">
          {d.last_gift_date ? fmtDate(d.last_gift_date) : <span className="text-gray-400">{EMDASH}</span>}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={8} className="bg-gray-50 p-0 border-y border-emerald-200">
            <DonorDetailPanel donor={d} locationId={locationId} crmAppBase={crmAppBase} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DonorDetailPanel({
  donor,
  locationId,
  crmAppBase,
}: {
  donor: DonorRow;
  locationId: string;
  crmAppBase: string;
}) {
  // Three-way fallback for the "Open in GHL" link:
  //   1. best_ghl_contact_id is set → direct deep-link to the contact
  //      (either a direct GHL search hit OR the matched parent's contact)
  //   2. has an email but no contact id → link to GHL's contact search
  //      page pre-filled with the email so the operator can find them
  //      in one click. (Most often happens for donors that haven't been
  //      enriched yet, or whose GHL email casing differs from DP's.)
  //   3. no email + no contact id → no link
  const contactUrl = donor.best_ghl_contact_id
    ? `${crmAppBase}/v2/location/${locationId}/contacts/detail/${donor.best_ghl_contact_id}`
    : donor.email
      ? `${crmAppBase}/v2/location/${locationId}/contacts/?searchTerm=${encodeURIComponent(donor.email)}`
      : null;
  const isDirectLink = !!donor.best_ghl_contact_id;

  return (
    <div className="px-6 py-5 space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-3 text-sm">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Donor</div>
          <div className="text-gray-900 font-medium">{donor.full_name}</div>
          {donor.email ? <div className="text-gray-700 text-xs break-all">{donor.email}</div> : null}
          {donor.phone ? <div className="text-gray-700 text-xs">{donor.phone}</div> : null}
          {donor.city || donor.state ? (
            <div className="text-gray-700 text-xs">{[donor.city, donor.state].filter(Boolean).join(', ')}</div>
          ) : null}
          {donor.org_rec === 'Y' ? (
            <div className="text-[11px] text-amber-700">Organization (business)</div>
          ) : null}
          {contactUrl ? (
            <a
              href={contactUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={
                isDirectLink
                  ? 'mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700'
                  : 'mt-2 inline-flex items-center gap-1 rounded-md border border-emerald-600 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50'
              }
              title={isDirectLink
                ? 'Opens the full contact record directly'
                : 'Opens contacts search prefilled with this donor’s email'}
            >
              {isDirectLink ? 'Open Full Contact Record →' : 'Find contact by email →'}
            </a>
          ) : donor.matched_family_id ? (
            <div className="mt-1 text-[10px] text-emerald-700">linked to a current family (no GHL contact id)</div>
          ) : null}
        </div>

        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Giving</div>
          <Row k="Lifetime" v={fmtMoney(donor.gift_total)} bold />
          <Row k="This school yr" v={fmtMoney(donor.ytd_school_year)} />
          <Row k="Last school yr" v={fmtMoney(donor.last_school_year)} />
          <Row k="Gifts (total)" v={String(donor.gift_count)} />
          <Row k="Last gift" v={donor.last_gift_date ? fmtDate(donor.last_gift_date) : EMDASH} />
        </div>

        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">Tags & Segment</div>
          {donor.inferred_segment ? (
            <div className="text-xs">
              <span className={segmentBadgeClass(donor.inferred_segment)}>
                {donor.inferred_segment.replace(/_/g, ' ')}
              </span>
            </div>
          ) : null}
          {donor.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1">
              {donor.tags.map((t) => (
                <span key={t} className="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded">
                  {t.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400 italic">no tags</div>
          )}
          <TagEditor donorId={donor.dp_donor_id} existing={donor.tags} />
        </div>
      </div>

      {donor.additional_notes || donor.vol_additional || donor.social_media || donor.linkedin || donor.facebook ? (
        <div className="rounded-md border border-gray-100 bg-white p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-1">Narrative</div>
          {donor.additional_notes ? (
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{donor.additional_notes}</p>
          ) : null}
          {donor.vol_additional ? (
            <p className="mt-1 text-xs text-gray-700">
              <span className="font-semibold">Volunteer notes:</span> {donor.vol_additional}
            </p>
          ) : null}
          {donor.social_media || donor.linkedin || donor.facebook ? (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              {donor.linkedin ? <a href={donor.linkedin} target="_blank" rel="noopener" className="text-blue-600 hover:underline">LinkedIn ↗</a> : null}
              {donor.facebook ? <a href={donor.facebook} target="_blank" rel="noopener" className="text-blue-600 hover:underline">Facebook ↗</a> : null}
              {donor.social_media ? <span className="text-gray-600">Social: {donor.social_media}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Operator-editable notes. Distinct from anything that came in
          from DonorPerfect — these survive every DP re-import. */}
      <SchoolNotesEditor
        donorId={donor.dp_donor_id}
        initialNotes={donor.school_notes ?? ''}
        initialUpdatedAt={donor.school_notes_updated_at}
      />

      {/* GHL native Notes — pulled live when the accordion opens.
          Only renders the panel if we have a contact id to query.
          Anything the school writes in GHL's Notes module on the
          contact will appear here on next page load. */}
      {donor.best_ghl_contact_id ? (
        <GhlNotesPanel ghlContactId={donor.best_ghl_contact_id} />
      ) : null}

      {/* Per-gift narrative log from DonorPerfect — touchpoints, donor
          background, conversations. Deduped because operators copy-paste
          the running log across multiple gifts on the same donor. */}
      {donor.narratives.length > 0 ? (
        <details className="rounded-md border border-amber-200 bg-amber-50/30 px-3 py-2">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-amber-800 font-semibold list-none">
            DonorPerfect notes ({donor.narratives.length})
            <span className="ml-2 font-normal text-amber-700 normal-case">— click to expand</span>
          </summary>
          <div className="mt-2 space-y-2 text-xs text-gray-800">
            {donor.narratives.map((n, i) => (
              <div key={i} className="rounded border border-amber-100 bg-white p-2 whitespace-pre-wrap">
                {n}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {/* Campaigns this donor has ever supported — quick badge row */}
      {donor.campaigns.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] uppercase tracking-wide text-gray-500 mr-1">Campaigns:</span>
          {donor.campaigns.map((c) => (
            <span
              key={c}
              className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800"
              title={c}
            >
              {c}
            </span>
          ))}
        </div>
      ) : null}

      <div className="rounded-md border border-gray-100 bg-white">
        <div className="px-3 py-1.5 border-b border-gray-100 text-[11px] uppercase tracking-wide text-gray-500 font-semibold">
          Gift history ({donor.gifts.length})
        </div>
        {donor.gifts.length === 0 ? (
          <div className="p-3 text-xs text-gray-500 italic">No gifts on record.</div>
        ) : (
          <table className="w-full text-xs">
            <tbody className="divide-y divide-gray-50">
              {donor.gifts.map((g) => {
                const campaign = g.solicit_code_descr || g.solicit_code;
                const tier = g.sub_solicit_code_descr;
                return (
                  <tr key={g.id}>
                    <td className="px-3 py-1 text-gray-700 align-top whitespace-nowrap">
                      {g.gift_date ? fmtDate(g.gift_date) : EMDASH}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums font-medium align-top whitespace-nowrap">
                      {fmtMoney(g.amount)}
                    </td>
                    <td className="px-3 py-1 align-top">
                      <div className="flex flex-wrap gap-1">
                        {campaign ? (
                          <span className="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                            {campaign}
                          </span>
                        ) : null}
                        {tier ? (
                          <span className="inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                            {tier}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-1 text-right text-[10px] text-gray-400 font-mono align-top whitespace-nowrap">
                      gift #{g.dp_gift_id}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ----- Inline tag editor ---------------------------------------------------

const SUGGESTED_TAGS = [
  'sponsor',
  'local_partner',
  'hr_parent',
  'top_donor',
  'volunteer_event',
  'volunteer_classroom',
  'volunteer_athletics',
  'alumni',
  'major_donor',
];

function TagEditor({ donorId, existing }: { donorId: string; existing: string[] }) {
  const [busy, setBusy] = useState(false);
  const available = SUGGESTED_TAGS.filter((t) => !existing.includes(t));

  async function addTag(tag: string) {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('dp_donor_id', donorId);
      fd.set('tag', tag);
      await fetch('/api/school/donor-tags/add', { method: 'POST', body: fd });
      // Re-render via full reload (the dashboard refetches with new tags)
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: string) {
    if (busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('dp_donor_id', donorId);
      fd.set('tag', tag);
      await fetch('/api/school/donor-tags/remove', { method: 'POST', body: fd });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  if (available.length === 0 && existing.length === 0) return null;

  return (
    <div className="mt-1 space-y-1">
      {existing.length > 0 ? (
        <div className="flex flex-wrap gap-0.5">
          {existing.map((t) => (
            <button
              key={t}
              onClick={() => removeTag(t)}
              disabled={busy}
              title="Click to remove"
              className="text-[10px] rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 hover:bg-rose-50 hover:text-rose-700"
            >
              {t.replace(/_/g, ' ')} ✕
            </button>
          ))}
        </div>
      ) : null}
      {available.length > 0 ? (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">+ add tag</summary>
          <div className="mt-1 flex flex-wrap gap-0.5">
            {available.map((t) => (
              <button
                key={t}
                onClick={() => addTag(t)}
                disabled={busy}
                className="rounded border border-gray-300 px-1.5 py-0.5 hover:bg-gray-100"
              >
                {t.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ----- GHL native Notes panel --------------------------------------------
//
// Lazy-loads the contact's GHL Notes when the accordion opens. Renders
// a loading spinner first, then the notes list. Empty-result still
// renders the panel so the operator knows "GHL has nothing on this
// donor" rather than thinking the section just didn't load.
//
// One network call per accordion expand. If a donor's expanded twice
// in a session, we re-fetch — that's intentional. Live data trumps
// browser session cache.

interface GhlNote {
  id: string;
  body: string;
  date_added: string | null;
  user_id: string | null;
}

function GhlNotesPanel({ ghlContactId }: { ghlContactId: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; notes: GhlNote[] }
    | { kind: 'err'; msg: string }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/school/donor-ghl-notes?ghl_contact_id=${encodeURIComponent(ghlContactId)}`);
        if (!r.ok) {
          if (cancelled) return;
          setState({ kind: 'err', msg: `HTTP ${r.status}` });
          return;
        }
        const data = await r.json();
        if (cancelled) return;
        if (data.ok) setState({ kind: 'ok', notes: data.notes ?? [] });
        else setState({ kind: 'err', msg: data.error || 'unknown' });
      } catch (e) {
        if (cancelled) return;
        setState({ kind: 'err', msg: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [ghlContactId]);

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/30 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide text-violet-900 font-semibold">
          Notes from CRM
          <span className="ml-2 text-[10px] font-normal normal-case text-violet-700">
            (live — anything added to this contact's Notes shows here)
          </span>
        </div>
        {state.kind === 'ok' ? (
          <div className="text-[10px] text-violet-700">
            {state.notes.length} note{state.notes.length === 1 ? '' : 's'}
          </div>
        ) : null}
      </div>

      {state.kind === 'loading' ? (
        <div className="text-xs italic text-violet-700 py-1">Loading from CRM…</div>
      ) : state.kind === 'err' ? (
        <div className="text-xs text-rose-700 py-1">
          Couldn&rsquo;t load notes from CRM: {state.msg}
        </div>
      ) : state.notes.length === 0 ? (
        <div className="text-xs italic text-violet-700 py-1">
          No notes attached to this contact in the CRM yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {state.notes.map((n) => (
            <li
              key={n.id}
              className="rounded border border-violet-100 bg-white p-2"
            >
              <div className="text-[10px] uppercase tracking-wide text-violet-700 mb-1">
                {n.date_added
                  ? new Date(n.date_added).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', year: 'numeric',
                      hour: 'numeric', minute: '2-digit',
                    })
                  : 'undated'}
              </div>
              <div className="text-xs text-gray-800 whitespace-pre-wrap">{n.body}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----- Inline operator-editable notes -------------------------------------
//
// Free-form textarea persisting to dp_donors.school_notes. Distinct
// from anything that came in via DonorPerfect — DP imports never
// touch this column, so notes are safe across re-syncs.
//
// Saves on click of the Save button (we don't auto-save on blur — that
// risks losing edits if the operator clicks away mid-thought). After a
// successful save we show "Saved Xs ago" inline; on failure we surface
// the error and keep the textarea editable.

function SchoolNotesEditor({
  donorId, initialNotes, initialUpdatedAt,
}: {
  donorId: string;
  initialNotes: string;
  initialUpdatedAt: string | null;
}) {
  const [value, setValue] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initialUpdatedAt);
  const [err, setErr] = useState<string | null>(null);
  const dirty = value !== (initialNotes ?? '');

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set('dp_donor_id', donorId);
      fd.set('notes', value);
      const r = await fetch('/api/school/donor-notes/save', { method: 'POST', body: fd });
      if (!r.ok) {
        const msg = await r.text();
        setErr(`Save failed: ${msg}`);
        return;
      }
      const data = await r.json();
      setSavedAt(data.saved_at);
    } catch (e) {
      setErr(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/30 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[11px] uppercase tracking-wide text-blue-900 font-semibold">
          Notes
          <span className="ml-2 text-[10px] font-normal normal-case text-blue-700">
            (editable — survives DonorPerfect re-imports)
          </span>
        </div>
        {savedAt ? (
          <div className="text-[10px] text-gray-500">
            Last saved {new Date(savedAt).toLocaleString()}
          </div>
        ) : null}
      </div>
      <textarea
        value={value}
        onChange={(e) => { setValue(e.target.value); setErr(null); }}
        placeholder="Type any notes about this donor — follow-ups, conversations, sponsorship interest, etc."
        rows={4}
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className={`rounded-md px-3 py-1 text-xs font-semibold ${
            dirty
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-200 text-gray-500 cursor-not-allowed'
          }`}
        >
          {busy ? 'Saving…' : (dirty ? 'Save notes' : 'Saved')}
        </button>
        {dirty && !busy ? (
          <button
            type="button"
            onClick={() => { setValue(initialNotes ?? ''); setErr(null); }}
            className="text-[11px] text-gray-500 hover:text-gray-700 underline"
          >Discard</button>
        ) : null}
        {err ? <span className="text-xs text-rose-700">{err}</span> : null}
      </div>
    </div>
  );
}

// ----- Sort header --------------------------------------------------------

function SortHeader({
  label,
  sortKey,
  current,
  align,
}: {
  label: string;
  sortKey: SortKey;
  current: WidgetSearchParams;
  align?: string;
}) {
  const active = (current.sort ?? 'lifetime') === sortKey;
  const dir = active && current.dir === 'asc' ? 'asc' : (active ? 'desc' : null);
  const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && k !== 'sort' && k !== 'dir' && k !== 'page') params.set(k, v);
  }
  params.set('sort', sortKey);
  params.set('dir', nextDir);
  const Icon = active ? (dir === 'desc' ? ChevronDown : ChevronUp) : ArrowUpDown;
  const cls = align === 'right' ? 'justify-end' : '';
  return (
    <a href={`?${params.toString()}`} className={`inline-flex items-center gap-0.5 hover:text-gray-700 ${cls}`}>
      {label} <Icon className="h-3 w-3" />
    </a>
  );
}

// ----- Tiny helpers --------------------------------------------------------

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-gray-500">{k}</span>
      <span className={bold ? 'font-semibold text-gray-900 tabular-nums' : 'text-gray-800 tabular-nums'}>{v}</span>
    </div>
  );
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDate(s: string): string {
  // Already YYYY-MM-DD
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function segmentBadgeClass(seg: string): string {
  const base = 'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide';
  switch (seg) {
    case 'business':       return `${base} bg-amber-100 text-amber-800`;
    case 'current_family': return `${base} bg-emerald-100 text-emerald-800`;
    case 'alumni_family':  return `${base} bg-blue-100 text-blue-800`;
    case 'individual':     return `${base} bg-gray-100 text-gray-700`;
    default:               return `${base} bg-gray-100 text-gray-700`;
  }
}
