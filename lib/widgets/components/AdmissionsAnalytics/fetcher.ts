// Admissions analytics — the recruitment funnel read straight from the
// CRM mirror (ghl_contacts / tags / field values / opportunities + the
// tag and stage change logs). Works before a school has any families in
// the roster: admissions is about prospects, not the enrolled graph.
//
// Unit of analysis = one APPLICANT (student). Families often reach the CRM
// through several contacts — the application, a calendar booking, a
// document upload — so contacts are first joined into family groups by
// shared email / person name, then split per student name. Contacts that
// carry no student of their own (the booking, the upload) count for every
// student in their family. A family group with no student at all is an
// inquiry-stage lead.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  admissionsAnalyticsDefaults,
  type AdmissionsAnalyticsConfig,
  type MatchRule,
  type MilestoneRule,
} from './config';
import {
  gradeSortKey, incomeSortKey, neighborhood, normGrade, normName, normZip,
  schoolKey, splitLanguages, titleCase,
} from './normalize';

interface Contact {
  id: string;
  first: string;
  last: string;
  email: string;
  source: string;
  dateAdded: Date | null;
  tags: Set<string>;
  fields: Map<string, string>;
  opps: Array<{ stage: string; lastChange: Date | null }>;
}

interface Unit {
  key: string;
  student: string | null;
  parent: string;
  primary: Contact;
  contacts: Contact[];
  tags: Set<string>;
  stages: Set<string>;
  dateAdded: Date | null;
  cycle: string;
  reached: Map<string, boolean>;
  dates: Map<string, { at: Date; estimated: boolean } | null>;
}

export interface CountRow { label: string; count: number; applied?: number }
export interface Breakdown { key: string; title: string; population: string; rows: CountRow[]; with_value: number; missing: number; note?: string }
export interface SourceRow { source: string; units: number; applications: number; completed: number; offers: number; enrolled: number }
export interface StepTiming { from: string; to: string; n: number; avg_days: number | null; median_days: number | null }
export interface IncompleteRow {
  student: string; parent: string; contact_id: string; missing: string[];
  days_since_application: number | null;
}

export interface AdmissionsAnalyticsData {
  ready: boolean;
  not_ready_reason?: string;
  cycles: string[];
  selected_cycle: string;
  cycle_window: string;
  units_in_cycle: number;
  excluded: { tagged: number; email: number; nameless: number };
  funnel: Array<{ key: string; label: string; count: number; pct_of_top: number; step_rate: number | null; optional: boolean }>;
  conversions: Array<{ from: string; to: string; rate: number | null; from_count: number; to_count: number }>;
  open_house: null | {
    registered: number; attended: number | null; no_show: number | null; unrecorded: number | null;
    applied_from_registered: number; applied_from_attended: number | null;
    by_event: Array<{ event: string; registered: number; attended: number; no_show: number; applied: number }>;
  };
  yield: null | { offers: number; accepted: number; enrolled: number };
  timing: { steps: StepTiming[]; inquiry_to_completed: StepTiming | null; estimated_dates: number };
  sources: { referral: SourceRow[]; referral_captured: number; channel: SourceRow[] };
  breakdowns: Breakdown[];
  documents: null | { applicants: number; complete: number; by_requirement: CountRow[]; incomplete: IncompleteRow[] };
  yoy: { milestones: Array<{ key: string; label: string }>; rows: Array<{ cycle: string; source: 'crm' | 'reported'; counts: Record<string, number | null> }> };
  notes: string[];
  location_id: string;
}

const DAY = 86_400_000;
const lc = (s: string) => s.toLowerCase().trim();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

function tagMatch(tags: Set<string>, pattern: string): boolean {
  const p = lc(pattern);
  if (p.endsWith('*')) {
    const pre = p.slice(0, -1);
    for (const t of tags) if (t.startsWith(pre)) return true;
    return false;
  }
  return tags.has(p);
}

function unitField(u: Unit, key: string | undefined): string {
  if (!key) return '';
  // Prefer the student's own contact, then any linked contact.
  const own = u.primary.fields.get(key);
  if (own) return own;
  for (const c of u.contacts) { const v = c.fields.get(key); if (v) return v; }
  return '';
}

function matches(u: Unit, rule: MatchRule | undefined): boolean {
  if (!rule) return false;
  if (rule.tags_any?.some((t) => tagMatch(u.tags, t))) return true;
  if (rule.tags_all?.length && rule.tags_all.every((t) => tagMatch(u.tags, t))) return true;
  if (rule.stages?.some((s) => u.stages.has(lc(s)))) return true;
  if (rule.field) {
    const v = unitField(u, rule.field.key);
    if (v && (!rule.field.values?.length || rule.field.values.some((x) => lc(x) === lc(v)))) return true;
  }
  return false;
}

function parseDate(v: string | undefined | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function cycleLabel(entryYear: number): string {
  return `${entryYear}-${String((entryYear + 1) % 100).padStart(2, '0')}`;
}

function cycleOf(u: Unit, cfg: AdmissionsAnalyticsConfig): string {
  const raw = unitField(u, cfg.cycle_field);
  if (raw) {
    const full = raw.match(/(\d{4})\s*[-–/]\s*(\d{2,4})/);
    if (full) return cycleLabel(parseInt(full[1], 10));
    const y = raw.match(/(\d{4})/);
    if (y) return cycleLabel(parseInt(y[1], 10));
  }
  if (!u.dateAdded) return 'Unknown';
  const y = u.dateAdded.getUTCFullYear();
  const m = u.dateAdded.getUTCMonth() + 1;
  return cycleLabel(m >= (cfg.cycle_start_month || 8) ? y + 1 : y);
}

function cycleWindow(cycle: string, startMonth: number): string {
  const m = cycle.match(/^(\d{4})-/);
  if (!m) return '';
  const entry = parseInt(m[1], 10);
  const fmt = (y: number, mo: number) => new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? entry - 1 : entry;
  return `families who reached you ${fmt(entry - 1, startMonth)} – ${fmt(endYear, endMonth)}, for fall ${entry} entry`;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timing(units: Unit[], from: MilestoneRule, to: MilestoneRule): StepTiming {
  const days: number[] = [];
  for (const u of units) {
    const a = u.dates.get(from.key);
    const b = u.dates.get(to.key);
    if (!a || !b) continue;
    const d = (b.at.getTime() - a.at.getTime()) / DAY;
    if (d >= 0) days.push(d);
  }
  const avg = days.length ? days.reduce((x, y) => x + y, 0) / days.length : null;
  return {
    from: from.label, to: to.label, n: days.length,
    avg_days: avg == null ? null : Math.round(avg * 10) / 10,
    median_days: (() => { const m = median(days); return m == null ? null : Math.round(m * 10) / 10; })(),
  };
}

function countBy(units: Unit[], valuesOf: (u: Unit) => string[], appliedKey?: string): { rows: CountRow[]; withValue: number } {
  const map = new Map<string, CountRow>();
  let withValue = 0;
  for (const u of units) {
    const vals = valuesOf(u).filter(Boolean);
    if (vals.length) withValue++;
    for (const v of vals) {
      const r = map.get(v) ?? { label: v, count: 0, applied: 0 };
      r.count++;
      if (appliedKey && u.reached.get(appliedKey)) r.applied = (r.applied ?? 0) + 1;
      map.set(v, r);
    }
  }
  return { rows: [...map.values()], withValue };
}

export async function fetcher(
  school: SchoolContext,
  rawConfig: Partial<AdmissionsAnalyticsConfig>,
  searchParams?: WidgetSearchParams,
): Promise<AdmissionsAnalyticsData> {
  const cfg: AdmissionsAnalyticsConfig = { ...admissionsAnalyticsDefaults, ...(rawConfig ?? {}) };
  const milestones = cfg.milestones?.length ? cfg.milestones : admissionsAnalyticsDefaults.milestones;
  const byKey = new Map(milestones.map((m) => [m.key, m]));
  const main = milestones.filter((m) => !m.optional);
  const sid = school.schoolId;

  const empty = (reason: string): AdmissionsAnalyticsData => ({
    ready: false, not_ready_reason: reason, cycles: [], selected_cycle: '', cycle_window: '',
    units_in_cycle: 0, excluded: { tagged: 0, email: 0, nameless: 0 }, funnel: [], conversions: [],
    open_house: null, yield: null, timing: { steps: [], inquiry_to_completed: null, estimated_dates: 0 },
    sources: { referral: [], referral_captured: 0, channel: [] }, breakdowns: [], documents: null,
    yoy: { milestones: [], rows: [] }, notes: [], location_id: school.locationId,
  });

  // ── Load the mirror ────────────────────────────────────────────────
  let contactRows: Array<{ ghl_contact_id: string; first_name: string | null; last_name: string | null; email: string | null; source: string | null; date_added: Date | null }>;
  try {
    ({ rows: contactRows } = await query(
      `SELECT ghl_contact_id, first_name, last_name, email, source, date_added
         FROM ghl_contacts WHERE school_id = $1`, [sid]));
  } catch {
    return empty('The contact mirror is not set up yet. It fills in on the next sync.');
  }
  if (!contactRows.length) return empty('No contacts synced yet. The next sync (every 15 minutes) fills this in.');

  const [tagRes, fvRes, oppRes, tagLogRes] = await Promise.all([
    query<{ ghl_contact_id: string; tag: string }>(`SELECT ghl_contact_id, tag FROM ghl_contact_tags WHERE school_id = $1`, [sid]),
    query<{ ghl_contact_id: string; field_key: string; value: string }>(`SELECT ghl_contact_id, field_key, value FROM ghl_contact_field_values WHERE school_id = $1`, [sid]),
    query<{ ghl_contact_id: string | null; stage_name: string | null; last_stage_change_at: Date | null }>(
      `SELECT ghl_contact_id, stage_name, last_stage_change_at FROM ghl_opportunities WHERE school_id = $1`, [sid]),
    query<{ ghl_contact_id: string; tag: string; first_seen: Date }>(
      `SELECT ghl_contact_id, lower(tag) AS tag, MIN(seen_at) AS first_seen
         FROM ghl_tag_changes WHERE school_id = $1 AND change = 'added' GROUP BY 1, 2`, [sid]),
  ]);
  let stageLog: Array<{ ghl_contact_id: string | null; to_stage: string | null; at: Date }> = [];
  try {
    ({ rows: stageLog } = await query(
      `SELECT ghl_contact_id, to_stage, MIN(COALESCE(stage_changed_at, seen_at)) AS at
         FROM ghl_opportunity_stage_changes WHERE school_id = $1 GROUP BY 1, 2`, [sid]));
  } catch { /* table not migrated yet — dates fall back */ }

  const contacts = new Map<string, Contact>();
  for (const r of contactRows) {
    contacts.set(r.ghl_contact_id, {
      id: r.ghl_contact_id, first: (r.first_name ?? '').trim(), last: (r.last_name ?? '').trim(),
      email: lc(r.email ?? ''), source: (r.source ?? '').trim(), dateAdded: r.date_added ? new Date(r.date_added) : null,
      tags: new Set(), fields: new Map(), opps: [],
    });
  }
  for (const r of tagRes.rows) contacts.get(r.ghl_contact_id)?.tags.add(lc(r.tag));
  for (const r of fvRes.rows) contacts.get(r.ghl_contact_id)?.fields.set(r.field_key, r.value);
  for (const r of oppRes.rows) {
    if (r.ghl_contact_id && r.stage_name) contacts.get(r.ghl_contact_id)?.opps.push({ stage: r.stage_name, lastChange: r.last_stage_change_at ? new Date(r.last_stage_change_at) : null });
  }
  const tagFirstSeen = new Map<string, Date>(); // contact|tag
  for (const r of tagLogRes.rows) tagFirstSeen.set(`${r.ghl_contact_id}|${r.tag}`, new Date(r.first_seen));
  const stageFirstSeen = new Map<string, Date>(); // contact|stage
  for (const r of stageLog) if (r.ghl_contact_id && r.to_stage) stageFirstSeen.set(`${r.ghl_contact_id}|${lc(r.to_stage)}`, new Date(r.at));

  // ── Exclusions ─────────────────────────────────────────────────────
  const excluded = { tagged: 0, email: 0, nameless: 0 };
  const exTags = (cfg.exclude_tags ?? []).map(lc);
  const exDomains = (cfg.exclude_email_domains ?? []).map(lc);
  const exEmails = new Set((cfg.exclude_emails ?? []).map(lc));
  const kept: Contact[] = [];
  for (const c of contacts.values()) {
    if (exTags.some((t) => tagMatch(c.tags, t))) { excluded.tagged++; continue; }
    const domain = c.email.split('@')[1] ?? '';
    if (exEmails.has(c.email) || (domain && exDomains.includes(domain))) { excluded.email++; continue; }
    if (cfg.require_contact_name && !c.first && !c.last) { excluded.nameless++; continue; }
    kept.push(c);
  }

  // ── Family groups (union-find on email + person names) ─────────────
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const studentOf = (c: Contact) => normName(`${c.fields.get(cfg.student_first_field) ?? ''} ${c.fields.get(cfg.student_last_field) ?? ''}`);
  const keyOwner = new Map<string, string>();
  for (const c of kept) {
    parent.set(c.id, c.id);
    const keys: string[] = [];
    if (c.email) keys.push('e:' + c.email);
    const p2 = lc(c.fields.get('parent_2_email') ?? '');
    if (p2) keys.push('e:' + p2);
    const own = normName(`${c.first} ${c.last}`);
    if (own.includes(' ')) keys.push('n:' + own);
    const stu = studentOf(c);
    if (stu.includes(' ')) keys.push('n:' + stu);
    for (const k of keys) {
      const o = keyOwner.get(k);
      if (o) union(c.id, o); else keyOwner.set(k, c.id);
    }
  }
  const groups = new Map<string, Contact[]>();
  for (const c of kept) { const r = find(c.id); (groups.get(r) ?? groups.set(r, []).get(r)!).push(c); }

  const units: Unit[] = [];
  for (const members of groups.values()) {
    const students = new Map<string, Contact[]>();
    const shared: Contact[] = [];
    for (const c of members) {
      const s = studentOf(c);
      if (s) (students.get(s) ?? students.set(s, []).get(s)!).push(c);
      else shared.push(c);
    }
    const build = (student: string | null, own: Contact[]): Unit => {
      const all = [...own, ...shared];
      const primary = [...own].sort((a, b) => b.fields.size - a.fields.size)[0] ?? [...all].sort((a, b) => b.fields.size - a.fields.size)[0];
      const studentDisplay = student
        ? titleCase(`${primary.fields.get(cfg.student_first_field) ?? ''} ${primary.fields.get(cfg.student_last_field) ?? ''}`)
        : null;
      const parentContact = all.find((c) => normName(`${c.first} ${c.last}`) !== student && (c.first || c.last)) ?? primary;
      const tags = new Set<string>(); const stages = new Set<string>();
      let added: Date | null = null;
      for (const c of all) {
        c.tags.forEach((t) => tags.add(t));
        c.opps.forEach((o) => stages.add(lc(o.stage)));
        if (c.dateAdded && (!added || c.dateAdded < added)) added = c.dateAdded;
      }
      return {
        key: primary.id, student: studentDisplay, parent: titleCase(`${parentContact.first} ${parentContact.last}`),
        primary, contacts: all, tags, stages, dateAdded: added, cycle: '', reached: new Map(), dates: new Map(),
      };
    };
    if (students.size === 0) units.push(build(null, []));
    else for (const [s, own] of students) units.push(build(s, own));
  }

  const missingDocs = (u: Unit): string[] => {
    const out: string[] = [];
    for (const r of cfg.documents ?? []) {
      if (r.only_if && lc(unitField(u, r.only_if.field)) !== lc(r.only_if.equals)) continue;
      if (!r.tags_any.some((t) => tagMatch(u.tags, t))) out.push(r.label);
    }
    return out;
  };

  // ── Milestones reached (later main milestones imply earlier ones) ──
  for (const u of units) {
    u.cycle = cycleOf(u, cfg);
    const hasStudent = !!u.student;
    for (const m of milestones) {
      const docsDone = !!m.documents_complete && hasStudent && (cfg.documents?.length ?? 0) > 0 && missingDocs(u).length === 0;
      u.reached.set(m.key, !!m.always || docsDone || matches(u, m));
    }
    let later = false;
    for (let i = main.length - 1; i >= 0; i--) {
      if (later) u.reached.set(main[i].key, true);
      if (u.reached.get(main[i].key)) later = true;
    }
  }

  // ── Milestone dates ────────────────────────────────────────────────
  let estimated = 0;
  for (const u of units) {
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      if (!u.reached.get(m.key)) { u.dates.set(m.key, null); continue; }
      let at: Date | null = parseDate(unitField(u, m.date_field));
      let est = false;
      if (!at && m.stages?.length) {
        for (const c of u.contacts) for (const s of m.stages) {
          const d = stageFirstSeen.get(`${c.id}|${lc(s)}`);
          if (d && (!at || d < at)) at = d;
        }
        // Card currently sits in this milestone's own stage → its last move is when it got here.
        if (!at) {
          const nextMain = main[main.findIndex((x) => x.key === m.key) + 1];
          const nextStages = new Set((nextMain?.stages ?? []).map(lc));
          for (const c of u.contacts) for (const o of c.opps) {
            if (o.lastChange && m.stages.some((s) => lc(s) === lc(o.stage)) && !nextStages.has(lc(o.stage))) {
              if (!at || o.lastChange < at) at = o.lastChange;
            }
          }
        }
      }
      if (!at) {
        const tagPats = [...(m.tags_any ?? []), ...(m.tags_all ?? [])];
        for (const c of u.contacts) for (const t of c.tags) {
          if (!tagPats.some((p) => tagMatch(new Set([t]), p))) continue;
          const d = tagFirstSeen.get(`${c.id}|${t}`);
          if (d && (!at || d < at)) at = d;
        }
      }
      if (!at && m.always) at = u.dateAdded;
      // Documents complete = when the last required document arrived
      // (known only once every one of them has a logged first-seen date).
      if (!at && m.documents_complete) {
        let last: Date | null = null; let allKnown = true;
        for (const r of cfg.documents ?? []) {
          if (r.only_if && lc(unitField(u, r.only_if.field)) !== lc(r.only_if.equals)) continue;
          let first: Date | null = null;
          for (const c of u.contacts) for (const t of c.tags) {
            if (!r.tags_any.some((p) => tagMatch(new Set([t]), p))) continue;
            const d = tagFirstSeen.get(`${c.id}|${t}`);
            if (d && (!first || d < first)) first = d;
          }
          if (!first) { allKnown = false; break; }
          if (!last || first > last) last = first;
        }
        if (allKnown && last) at = last;
      }
      // Estimate: the contact that carries this milestone's tag was created
      // by that submission (e.g. the application form makes the contact).
      if (!at && (m.tags_any?.length || m.tags_all?.length)) {
        const pats = [...(m.tags_any ?? []), ...(m.tags_all ?? [])];
        for (const c of u.contacts) {
          if (c.dateAdded && pats.some((p) => tagMatch(c.tags, p)) && (!at || c.dateAdded < at)) { at = c.dateAdded; est = true; }
        }
      }
      if (est && at) estimated++;
      u.dates.set(m.key, at ? { at, estimated: est } : null);
    }
  }

  // ── Cycle selection ────────────────────────────────────────────────
  const appKey = byKey.has('application') ? 'application' : main[1]?.key ?? main[0].key;
  const cycleSet = new Set<string>(units.map((u) => u.cycle));
  for (const p of cfg.prior_cycles ?? []) cycleSet.add(p.cycle);
  const cycles = [...cycleSet].filter((c) => c !== 'Unknown').sort().reverse();
  const withApps = cycles.filter((c) => units.some((u) => u.cycle === c && u.reached.get(appKey)));
  const requested = (searchParams?.cycle ?? '').trim();
  const selected = (requested && cycleSet.has(requested) ? requested : '')
    || (cfg.default_cycle && cycleSet.has(cfg.default_cycle) ? cfg.default_cycle : '')
    || withApps[0] || cycles[0] || 'Unknown';
  const inCycle = units.filter((u) => u.cycle === selected);
  const applicants = inCycle.filter((u) => u.reached.get(appKey));

  // ── Funnel + conversions ───────────────────────────────────────────
  const count = (key: string, pop = inCycle) => pop.filter((u) => u.reached.get(key)).length;
  // A stage whose only data source is the pipeline has no rate (not 0%)
  // while nobody in the cycle has a pipeline card.
  const cycleHasOpps = inCycle.some((u) => u.stages.size > 0);
  const pipelineOnly = (m: MilestoneRule) => !!m.stages?.length && !m.tags_any?.length && !m.tags_all?.length && !m.field && !m.date_field && !m.documents_complete;
  const unmeasured = (m: MilestoneRule) => pipelineOnly(m) && !cycleHasOpps;
  const top = count(milestones[0].key);
  let prevMain: string | null = null;
  const funnel = milestones.map((m) => {
    const n = count(m.key);
    const step = !m.optional && prevMain && !unmeasured(m) ? pct(n, count(prevMain)) : null;
    if (!m.optional) prevMain = m.key;
    return { key: m.key, label: m.label, count: n, pct_of_top: top ? Math.round((n / top) * 100) : 0, step_rate: step, optional: !!m.optional };
  });
  const conversions = main.slice(1).map((m, i) => {
    const f = main[i];
    const a = count(f.key), b = count(m.key);
    return { from: f.label, to: m.label, rate: unmeasured(m) || unmeasured(f) ? null : pct(b, a), from_count: a, to_count: b };
  });
  if (main.length > 2) {
    const f = main[0], l = main[main.length - 1];
    conversions.push({ from: f.label, to: `${l.label} (overall)`, rate: unmeasured(l) ? null : pct(count(l.key), count(f.key)), from_count: count(f.key), to_count: count(l.key) });
  }

  // ── Open house ─────────────────────────────────────────────────────
  let open_house: AdmissionsAnalyticsData['open_house'] = null;
  if (byKey.has('open_house')) {
    const reg = inCycle.filter((u) => u.reached.get('open_house'));
    const att = reg.filter((u) => matches(u, cfg.open_house_attended));
    const ns = reg.filter((u) => matches(u, cfg.open_house_no_show));
    // Show attendance only once someone has actually recorded it.
    const hasAttendanceRule = att.length + ns.length > 0;
    const events = new Map<string, { event: string; registered: number; attended: number; no_show: number; applied: number }>();
    const prefix = lc(cfg.open_house_event_tag_prefix ?? '');
    for (const u of reg) {
      // The event field names the exact session; tags are the fallback
      // (both describe the same registration — never count it twice).
      const evs = new Set<string>();
      const fv = unitField(u, cfg.open_house_event_field);
      if (fv) evs.add(fv.trim());
      else if (prefix) for (const t of u.tags) if (t.startsWith(prefix)) evs.add(titleCase(t.slice(prefix.length).trim()) || titleCase(t));
      if (!evs.size) evs.add('Event not recorded');
      for (const e of evs) {
        const r = events.get(e) ?? { event: e, registered: 0, attended: 0, no_show: 0, applied: 0 };
        r.registered++;
        if (att.includes(u)) r.attended++;
        if (ns.includes(u)) r.no_show++;
        if (u.reached.get(appKey)) r.applied++;
        events.set(e, r);
      }
    }
    open_house = {
      registered: reg.length,
      attended: hasAttendanceRule ? att.length : null,
      no_show: hasAttendanceRule ? ns.length : null,
      unrecorded: hasAttendanceRule ? reg.filter((u) => !att.includes(u) && !ns.includes(u)).length : null,
      applied_from_registered: reg.filter((u) => u.reached.get(appKey)).length,
      applied_from_attended: hasAttendanceRule ? att.filter((u) => u.reached.get(appKey)).length : null,
      by_event: [...events.values()].sort((a, b) => b.registered - a.registered),
    };
  }

  // ── Yield ──────────────────────────────────────────────────────────
  const yieldData = byKey.has('offer') && byKey.has('enrolled')
    ? { offers: count('offer'), accepted: byKey.has('accepted') ? count('accepted') : 0, enrolled: count('enrolled') }
    : null;

  // ── Timing ─────────────────────────────────────────────────────────
  const steps = main.slice(1).map((m, i) => timing(inCycle, main[i], m));
  const inqRule = byKey.get('inquiry') ?? main[0];
  const compRule = byKey.get('completed');
  const inquiry_to_completed = compRule ? timing(inCycle, inqRule, compRule) : null;

  // ── Sources ────────────────────────────────────────────────────────
  const sourceRows = (valueOf: (u: Unit) => string): SourceRow[] => {
    const map = new Map<string, SourceRow>();
    for (const u of inCycle) {
      const s = valueOf(u) || 'Not captured';
      const r = map.get(s) ?? { source: s, units: 0, applications: 0, completed: 0, offers: 0, enrolled: 0 };
      r.units++;
      if (u.reached.get(appKey)) r.applications++;
      if (u.reached.get('completed')) r.completed++;
      if (u.reached.get('offer')) r.offers++;
      if (u.reached.get('enrolled')) r.enrolled++;
      map.set(s, r);
    }
    return [...map.values()].sort((a, b) => b.applications - a.applications || b.units - a.units);
  };
  const referralOf = (u: Unit) => {
    for (const f of cfg.referral_fields ?? []) { const v = unitField(u, f); if (v) return titleCase(v); }
    return '';
  };
  const channelOf = (u: Unit) => {
    // Earliest contact's source = how the family first came in.
    const first = [...u.contacts].filter((c) => c.source).sort((a, b) => (a.dateAdded?.getTime() ?? 0) - (b.dateAdded?.getTime() ?? 0))[0];
    return first ? titleCase(first.source) : '';
  };
  const referral = sourceRows(referralOf);
  const referral_captured = inCycle.filter((u) => referralOf(u)).length;

  // ── Demographic breakdowns (applicants) ────────────────────────────
  const breakdowns: Breakdown[] = [];
  const addBreakdown = (key: string, title: string, fieldKey: string | undefined, valuesOf: (u: Unit) => string[], sort: (a: CountRow, b: CountRow) => number, note?: string) => {
    if (!fieldKey) return;
    const { rows, withValue } = countBy(applicants, valuesOf);
    breakdowns.push({ key, title, population: 'applicants', rows: rows.sort(sort), with_value: withValue, missing: applicants.length - withValue, note });
  };
  const byCount = (a: CountRow, b: CountRow) => b.count - a.count || a.label.localeCompare(b.label);
  addBreakdown('neighborhood', 'Families by neighborhood', cfg.zip_field ?? cfg.city_field,
    (u) => { const n = neighborhood(normZip(unitField(u, cfg.zip_field)), unitField(u, cfg.city_field)); return n ? [n] : []; }, byCount,
    'Boston ZIPs are mapped to neighborhoods; other towns show by city.');
  addBreakdown('zip', 'Families by ZIP code', cfg.zip_field,
    (u) => { const z = normZip(unitField(u, cfg.zip_field)); return z ? [z] : []; }, byCount);
  if (cfg.current_school_field) {
    const aliases = Object.fromEntries(Object.entries(cfg.current_school_aliases ?? {}).map(([k, v]) => [schoolKey(k), v]));
    const display = new Map<string, Map<string, number>>();
    for (const u of applicants) {
      const raw = unitField(u, cfg.current_school_field).trim();
      if (!raw) continue;
      const k = schoolKey(raw);
      const m = display.get(k) ?? new Map(); m.set(raw, (m.get(raw) ?? 0) + 1); display.set(k, m);
    }
    const nameFor = (k: string) => aliases[k] ?? titleCase([...(display.get(k) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? k);
    addBreakdown('current_school', 'Applicants by current school', cfg.current_school_field,
      (u) => { const raw = unitField(u, cfg.current_school_field).trim(); return raw ? [nameFor(schoolKey(raw))] : []; }, byCount,
      'Spelling variants are grouped; add aliases in the dashboard settings to merge the rest.');
  }
  addBreakdown('current_grade', 'Applicants by current grade', cfg.current_grade_field,
    (u) => { const g = normGrade(unitField(u, cfg.current_grade_field)); return g ? [g] : []; },
    (a, b) => gradeSortKey(a.label) - gradeSortKey(b.label));
  addBreakdown('applying_grade', 'Applicants by grade applying for', cfg.applying_grade_field,
    (u) => { const g = normGrade(unitField(u, cfg.applying_grade_field)); return g ? [g] : []; },
    (a, b) => gradeSortKey(a.label) - gradeSortKey(b.label));
  addBreakdown('income', 'Household income', cfg.income_field,
    (u) => { const v = unitField(u, cfg.income_field).trim(); return v ? [v] : []; },
    (a, b) => incomeSortKey(a.label) - incomeSortKey(b.label));
  addBreakdown('household_size', 'Household size', cfg.household_size_field,
    (u) => { const n = parseInt(unitField(u, cfg.household_size_field), 10); return Number.isFinite(n) && n > 0 ? [n >= 8 ? '8+ people' : `${n} people`] : []; },
    (a, b) => parseInt(a.label, 10) - parseInt(b.label, 10));
  addBreakdown('languages', 'Languages spoken at home', cfg.languages_field,
    (u) => splitLanguages(unitField(u, cfg.languages_field), cfg.language_aliases), byCount,
    'A family listing several languages counts once for each.');

  // ── Documents ──────────────────────────────────────────────────────
  let documents: AdmissionsAnalyticsData['documents'] = null;
  if (cfg.documents?.length) {
    const req = cfg.documents;
    const byReq = new Map(req.map((r) => [r.label, 0]));
    const incomplete: IncompleteRow[] = [];
    let complete = 0;
    const now = Date.now();
    for (const u of applicants) {
      const missing = missingDocs(u);
      for (const m of missing) byReq.set(m, (byReq.get(m) ?? 0) + 1);
      if (!missing.length) { complete++; continue; }
      const appDate = u.dates.get(appKey)?.at;
      incomplete.push({
        student: u.student ?? u.parent, parent: u.parent, contact_id: u.primary.id, missing,
        days_since_application: appDate ? Math.floor((now - appDate.getTime()) / DAY) : null,
      });
    }
    incomplete.sort((a, b) => b.missing.length - a.missing.length || a.student.localeCompare(b.student));
    documents = {
      applicants: applicants.length, complete,
      by_requirement: [...byReq.entries()].map(([label, n]) => ({ label, count: n })),
      incomplete,
    };
  }

  // ── Year over year ─────────────────────────────────────────────────
  const yoyMilestones = milestones.map((m) => ({ key: m.key, label: m.label }));
  const yoyRows = cycles.slice(0, 6).map((c) => {
    const pop = units.filter((u) => u.cycle === c);
    const reported = (cfg.prior_cycles ?? []).find((p) => p.cycle === c);
    if (!pop.length && reported) {
      const counts: Record<string, number | null> = {};
      for (const m of milestones) counts[m.key] = reported[m.key] == null ? null : Number(reported[m.key]);
      return { cycle: c, source: 'reported' as const, counts };
    }
    const counts: Record<string, number | null> = {};
    for (const m of milestones) counts[m.key] = pop.filter((u) => u.reached.get(m.key)).length;
    return { cycle: c, source: 'crm' as const, counts };
  });

  // ── Guidance for what isn't captured yet ───────────────────────────
  const notes: string[] = [];
  const stageRules = milestones.filter(pipelineOnly);
  if (stageRules.length && !cycleHasOpps) {
    notes.push(`${stageRules.map((m) => m.label).join(', ')} come from the Admissions Pipeline, but no applicant in this cycle has a pipeline card yet. Add a card per applicant and move it through the stages.`);
  }
  if (referral_captured === 0 && (cfg.referral_fields ?? []).length) {
    notes.push('No family in this cycle has a recruitment source recorded. Add a "How did you hear about us" dropdown to the inquiry and application forms.');
  }
  if (open_house && open_house.attended == null) {
    notes.push('Open house attendance and no-shows are not recorded yet. Mark each registrant Attended or No-show after the event.');
  }
  if (!steps.some((s) => s.n > 0)) {
    notes.push('Time-in-stage needs the date each stage was reached. Add milestone date fields (stamped automatically by workflows), or move pipeline cards — stage moves are logged from now on.');
  }
  if (estimated > 0) {
    notes.push(`${estimated} milestone date(s) are estimated from the date the matching contact was created.`);
  }

  return {
    ready: true,
    cycles,
    selected_cycle: selected,
    cycle_window: cycleWindow(selected, cfg.cycle_start_month || 8),
    units_in_cycle: inCycle.length,
    excluded,
    funnel,
    conversions,
    open_house,
    yield: yieldData,
    timing: { steps, inquiry_to_completed, estimated_dates: estimated },
    sources: { referral, referral_captured, channel: sourceRows(channelOf) },
    breakdowns,
    documents,
    yoy: { milestones: yoyMilestones, rows: yoyRows },
    notes,
    location_id: school.locationId,
  };
}
