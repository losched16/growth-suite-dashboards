// Pure planning core of the enrolled-family sync (I/O lives in
// enrolled-family-sync.ts). Input: every contact holding an open "Enrolled"
// card, already mapped with the full sync's own contact→family mapper, plus a
// snapshot of the current roster. Output: what to ADD.
//
// Deliberately one-directional: it can create a family, add a student or a
// co-parent, fill a blank parent email, and upgrade an enrollment to
// "enrolled" — nothing else. It never proposes a delete, a rename, or an
// overwrite of existing data. Whenever the safe answer isn't certain (bad
// source data, a child that might already be on the roster, an email change)
// it emits an attention item for a person instead of guessing — a duplicate
// family or a stranger attached to someone else's child is worse than a
// short delay.

import type { MappedFamily } from './run-ghl-sync';

type MappedParent = MappedFamily['parents'][number];
type MappedStudent = MappedFamily['students'][number];

export interface Card {
  id: string;
  name: string;             // card title — the child's name at card-per-student schools
  funnel: string | null;    // pipelineStageToFunnelStatus(stage_name)
  status: string | null;    // GHL opportunity status: open / won / lost / abandoned
}

export interface CandidateContact {
  contactId: string;
  contactName: string;
  // The full sync's mapping of this contact; null when it isn't a family
  // record (a Parent-2 communication contact, or no usable data).
  mapped: MappedFamily | null;
  cards: Card[];            // ALL of this contact's cards, not only enrolled ones
  wantsSecondParent: boolean;
}

export interface RosterParent {
  id: string;
  familyId: string;
  contactId: string | null;
  email: string | null;
  firstName: string;
  lastName: string;
  isPrimary: boolean;
}

export interface RosterStudent {
  id: string;
  familyId: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  dob: string | null;
  enrollmentId: string | null;
  enrollmentStatus: string | null;
}

export interface PlanInput {
  candidates: CandidateContact[];
  // Mapped PRIMARY contact of existing families, for families whose enrolled
  // card sits on a secondary contact — a new sibling's data lives on the
  // primary contact, not on the card's contact.
  primaryMappedByFamily: Map<string, MappedFamily>;
  familyNames: Map<string, string>;
  parents: RosterParent[];
  students: RosterStudent[];
}

export interface Plan {
  // familyRef is an existing family id, or `new:<contactId>` for a family
  // created earlier in this same plan.
  createFamilies: Array<{ ref: string; contactId: string; family: MappedFamily }>;
  addStudents: Array<{ familyRef: string; contactId: string; student: MappedStudent }>;
  addParents: Array<{ familyRef: string; contactId: string; parent: MappedParent }>;
  fillParentEmails: Array<{ parentId: string; email: string; name: string }>;
  upgradeEnrollments: Array<{ studentId: string; enrollmentId: string | null; name: string; from: string | null }>;
  attention: Array<{ key: string; message: string }>;
  unchanged: number;        // enrolled cards already fully reflected on the roster
}

// ---- name helpers -----------------------------------------------------------

// Lowercase, strip accents, quotes and punctuation; hyphens split words. Both
// sides of every comparison go through this, so "D'Ambrosio", "Arruda-Leuppert"
// and a quoted nickname ("Izzy" Yseult) compare consistently.
export function nameTokens(s: string | null | undefined): string[] {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function fullKey(first: string | null | undefined, last: string | null | undefined): string {
  return nameTokens(`${first ?? ''} ${last ?? ''}`).join(' ');
}

// A card title names a person when every token of their last name AND of
// their first (or preferred) name appears in it — tolerates middle names and
// nicknames in the title ("Ruby Josephine “Jojo” Birke" names Ruby Birke) while
// still telling siblings apart by first name.
export function cardNames(cardName: string, first: string, last: string, preferred?: string | null): boolean {
  const c = new Set(nameTokens(cardName));
  const lastT = nameTokens(last);
  if (lastT.length === 0 || !lastT.every((t) => c.has(t))) return false;
  const firstT = nameTokens(first);
  if (firstT.length > 0 && firstT.every((t) => c.has(t))) return true;
  const prefT = nameTokens(preferred);
  return prefT.length > 0 && prefT.every((t) => c.has(t));
}

export function isEnrolledCard(k: Card): boolean {
  const st = String(k.status ?? '').toLowerCase();
  return k.funnel === 'enrolled' && st !== 'lost' && st !== 'abandoned';
}

function dobRelation(a: string | null | undefined, b: string | null | undefined): 'equal' | 'differ' | 'unknown' {
  const x = (a ?? '').slice(0, 10);
  const y = (b ?? '').slice(0, 10);
  if (!x || !y) return 'unknown';
  return x === y ? 'equal' : 'differ';
}

// ---- working roster (grows as the plan adds, so later candidates see it) ---

interface WParent { id: string | null; contactId: string | null; email: string | null; first: string; last: string; isPrimary: boolean }
interface WStudent { id: string | null; first: string; last: string; preferred: string | null; dob: string | null; enrollmentId: string | null; enrollmentStatus: string | null }
interface WFamily { ref: string; name: string; parents: WParent[]; students: WStudent[] }

export function planEnrolledFamilySync(input: PlanInput): Plan {
  const plan: Plan = {
    createFamilies: [], addStudents: [], addParents: [], fillParentEmails: [],
    upgradeEnrollments: [], attention: [], unchanged: 0,
  };

  const fams = new Map<string, WFamily>();
  const fam = (ref: string): WFamily => {
    let f = fams.get(ref);
    if (!f) { f = { ref, name: input.familyNames.get(ref) ?? 'a family', parents: [], students: [] }; fams.set(ref, f); }
    return f;
  };
  const byContact = new Map<string, Set<string>>();
  const byEmail = new Map<string, Set<string>>();
  const link = (m: Map<string, Set<string>>, k: string | null | undefined, ref: string) => {
    if (!k) return;
    let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(ref);
  };
  const lc = (e: string | null | undefined) => (e ?? '').trim().toLowerCase() || null;

  for (const p of input.parents) {
    fam(p.familyId).parents.push({ id: p.id, contactId: p.contactId, email: p.email, first: p.firstName, last: p.lastName, isPrimary: p.isPrimary });
    link(byContact, p.contactId, p.familyId);
    link(byEmail, lc(p.email), p.familyId);
  }
  for (const s of input.students) {
    fam(s.familyId).students.push({ id: s.id, first: s.firstName, last: s.lastName, preferred: s.preferredName, dob: s.dob, enrollmentId: s.enrollmentId, enrollmentStatus: s.enrollmentStatus });
  }

  const seenAttention = new Set<string>();
  const attention = (key: string, message: string) => {
    if (seenAttention.has(key)) return;
    seenAttention.add(key);
    plan.attention.push({ key, message });
  };
  const upgraded = new Set<string>();
  const upgrade = (s: WStudent) => {
    if (!s.id || upgraded.has(s.id)) return;
    upgraded.add(s.id);
    plan.upgradeEnrollments.push({ studentId: s.id, enrollmentId: s.enrollmentId, name: `${s.first} ${s.last}`.trim(), from: s.enrollmentStatus });
    s.enrollmentStatus = 'enrolled';
  };
  const famLabel = (f: WFamily) => f.name;

  // The same child anywhere on the roster (other than `exceptRef`).
  const findChild = (first: string, last: string, dob: string | null, exceptRef: string | null) => {
    const key = fullKey(first, last);
    const hits: Array<{ ref: string; rel: 'equal' | 'differ' | 'unknown' }> = [];
    if (!key) return hits;
    for (const f of fams.values()) {
      if (f.ref === exceptRef) continue;
      for (const s of f.students) {
        if (fullKey(s.first, s.last) !== key) continue;
        const rel = dobRelation(dob, s.dob);
        if (rel !== 'differ') hits.push({ ref: f.ref, rel });
      }
    }
    return hits;
  };

  const isParentName = (s: MappedStudent, parents: Array<{ first: string; last: string }>) => {
    const k = fullKey(s.first_name, s.last_name);
    return k !== '' && parents.some((p) => fullKey(p.first, p.last) === k);
  };

  // Add an enrolled child to F (existing or planned-new). Guards: a child who
  // carries a parent's name is a data-entry error; a child who may already be
  // in another family must not be duplicated.
  const addStudentTo = (F: WFamily, s: MappedStudent, contactId: string, parentNames: Array<{ first: string; last: string }>) => {
    if (isParentName(s, [...parentNames, ...F.parents])) {
      attention(`namehazard:${contactId}:${fullKey(s.first_name, s.last_name)}`,
        `${famLabel(F)}: the contact lists "${s.first_name} ${s.last_name}" as a student, exactly a parent's name — usually the parent's name typed into the Student fields. Correct Student First/Last Name in Growth Suite (if the child truly shares the parent's name, add "Jr." or a middle name); the child is added on the next sync.`);
      return;
    }
    const elsewhere = findChild(s.first_name, s.last_name, s.date_of_birth, F.ref);
    if (elsewhere.length > 0) {
      attention(`childelsewhere:${F.ref}:${fullKey(s.first_name, s.last_name)}`,
        `${famLabel(F)}: "${s.first_name} ${s.last_name}" has an Enrolled card but a child with that name is already in another family on the roster — confirm whether it's the same child before anything is added.`);
      return;
    }
    const student: MappedStudent = { ...s, enrollment_status: 'enrolled' };
    plan.addStudents.push({ familyRef: F.ref, contactId, student });
    F.students.push({ id: null, first: s.first_name, last: s.last_name, preferred: s.preferred_name, dob: s.date_of_birth, enrollmentId: null, enrollmentStatus: 'enrolled' });
  };

  // A co-parent entered in the Parent 2 fields of F's record.
  const addCoParent = (F: WFamily, p: MappedParent, contactId: string, primaryOfRecord: MappedParent | undefined) => {
    const em = lc(p.email);
    if (!em) return; // no email → no login; nothing useful to add
    if (F.parents.some((x) => lc(x.email) === em)) return;
    const others = [...(byEmail.get(em) ?? [])].filter((r) => r !== F.ref);
    if (others.length > 0) {
      attention(`p2elsewhere:${F.ref}:${em}`,
        `${famLabel(F)}: Parent 2 email ${p.email} on the contact already belongs to a parent in another family — check the Parent 2 fields in Growth Suite.`);
      return;
    }
    const key = fullKey(p.first_name, p.last_name);
    if (primaryOfRecord && key && key === fullKey(primaryOfRecord.first_name, primaryOfRecord.last_name)) return; // copy of the primary
    const sameName = key ? F.parents.find((x) => fullKey(x.first, x.last) === key) : undefined;
    if (sameName) {
      if (!lc(sameName.email) && sameName.id) {
        // The parent is already on the family without an email: filling a
        // blank never breaks anyone's login, so it's safe to do.
        plan.fillParentEmails.push({ parentId: sameName.id, email: p.email!.trim(), name: `${sameName.first} ${sameName.last}`.trim() });
        sameName.email = p.email!.trim();
        link(byEmail, em, F.ref);
      } else if (lc(sameName.email) !== em) {
        attention(`emailchange:${F.ref}:${key}`,
          `${famLabel(F)}: ${p.first_name} ${p.last_name}'s email in Growth Suite (${p.email}) differs from their portal login (${sameName.email}). The sync never changes a login email on its own — confirm which is right and update the portal.`);
      }
      return;
    }
    plan.addParents.push({ familyRef: F.ref, contactId, parent: { ...p, is_primary: false, ghl_contact_id: null } });
    F.parents.push({ id: null, contactId: null, email: p.email, first: p.first_name, last: p.last_name, isPrimary: false });
    link(byEmail, em, F.ref);
  };

  const findOnRecord = (card: Card, m: MappedFamily | null | undefined): MappedStudent | undefined =>
    m?.students.find((s) => cardNames(card.name, s.first_name, s.last_name, s.preferred_name));

  const secondParentCheck = (F: WFamily, c: CandidateContact) => {
    if (c.wantsSecondParent && F.parents.length < 2) {
      attention(`p2missing:${c.contactId}`,
        `${famLabel(F)}: the application asked to add a second parent, but the Parent 2 fields on ${c.contactName}'s contact are empty — fill Parent 2 First/Last Name and Email in Growth Suite and they get portal access on the next sync.`);
    }
  };

  // ---- a contact already linked to exactly one family ----------------------
  const augmentLinked = (F: WFamily, c: CandidateContact, enrolled: Card[]) => {
    for (const card of enrolled) {
      const inF = F.students.filter((s) => cardNames(card.name, s.first, s.last, s.preferred));
      if (inF.length === 1) {
        if (inF[0].enrollmentStatus !== 'enrolled') upgrade(inF[0]); else plan.unchanged++;
        continue;
      }
      if (inF.length > 1) { plan.unchanged++; continue; }
      // A parent-named card is the family's own card: nothing is missing.
      if (F.parents.some((p) => cardNames(card.name, p.first, p.last))) {
        if (F.students.length === 1 && F.students[0].enrollmentStatus !== 'enrolled') upgrade(F.students[0]);
        else plan.unchanged++;
        continue;
      }
      // A child not yet in F: their data is on this contact, or on F's
      // primary contact when the card sits on a secondary one.
      const s = findOnRecord(card, c.mapped) ?? findOnRecord(card, input.primaryMappedByFamily.get(F.ref));
      if (!s) {
        attention(`card:${card.id}`,
          `${famLabel(F)}: Enrolled card "${card.name}" has no student by that name on the family's contact record — add the child to the primary parent's Student fields in Growth Suite (or correct the card name).`);
        continue;
      }
      const parentNames = (c.mapped?.parents ?? []).map((p) => ({ first: p.first_name, last: p.last_name }));
      addStudentTo(F, s, c.contactId, parentNames);
    }
    if (c.mapped) {
      const primary = c.mapped.parents.find((p) => p.is_primary);
      for (const p of c.mapped.parents) if (!p.is_primary) addCoParent(F, p, c.contactId, primary);
      secondParentCheck(F, c);
    }
  };

  // Resolve each mapped student's status from this contact's cards: the card
  // named for the child, or — for a single-child record with a single card
  // (typically still titled with the parent's name) — that card.
  const resolveStatuses = (c: CandidateContact): Map<MappedStudent, string | null> => {
    const out = new Map<MappedStudent, string | null>();
    const kids = c.mapped?.students ?? [];
    for (const s of kids) {
      const named = c.cards.find((k) => cardNames(k.name, s.first_name, s.last_name, s.preferred_name));
      out.set(s, named ? (isEnrolledCard(named) ? 'enrolled' : named.funnel) : null);
    }
    if (kids.length === 1 && out.get(kids[0]) === null && c.cards.length === 1) {
      out.set(kids[0], isEnrolledCard(c.cards[0]) ? 'enrolled' : c.cards[0].funnel);
    }
    return out;
  };

  // ---- a contact not linked to any family ----------------------------------
  const handleUnlinked = (c: CandidateContact, enrolled: Card[]) => {
    if (!c.mapped) {
      // Not a family record (e.g. a Parent-2 communication contact). Its
      // cards are fine as long as the child is on the roster.
      for (const card of enrolled) {
        const onRoster = [...fams.values()].some((f) => f.students.some((s) => cardNames(card.name, s.first, s.last, s.preferred)));
        if (onRoster) { plan.unchanged++; continue; }
        attention(`card:${card.id}`,
          `Enrolled card "${card.name}" is on ${c.contactName}'s contact, which is a Parent 2 / communication record rather than a family record, and that child isn't on the roster — move the card to the primary parent's contact (with the child in its Student fields).`);
      }
      return;
    }
    const m = c.mapped;
    const primary = m.parents.find((p) => p.is_primary);
    const label = primary ? `${primary.first_name} ${primary.last_name}`.trim() : c.contactName;
    const statuses = resolveStatuses(c);

    // Is this someone we already have? Strong evidence only: an email on the
    // roster, or a child with the same name AND the same date of birth.
    const strong = new Set<string>();
    let evidenceBeyondOwnEmail = false;
    for (const p of m.parents) {
      for (const r of byEmail.get(lc(p.email) ?? '') ?? []) {
        strong.add(r);
        if (!p.is_primary) evidenceBeyondOwnEmail = true;
      }
    }
    const weakRefs = new Set<string>();
    for (const s of m.students) {
      for (const h of findChild(s.first_name, s.last_name, s.date_of_birth, null)) {
        if (h.rel === 'equal') { strong.add(h.ref); evidenceBeyondOwnEmail = true; }
        else weakRefs.add(h.ref);
      }
    }

    if (strong.size > 1) {
      attention(`ambiguous:${c.contactId}`,
        `${label}'s contact matches several families on the roster (${[...strong].map((r) => fam(r).name).join(', ')}) — resolve which family it belongs to.`);
      return;
    }
    if (strong.size === 1) {
      // A member of an existing family whose own contact isn't linked yet —
      // typically a co-parent's contact. Never create a second family.
      const F = fam([...strong][0]);
      const pEm = lc(primary?.email);
      const pKey = fullKey(primary?.first_name, primary?.last_name);
      if (primary && pEm && !byEmail.has(pEm) && evidenceBeyondOwnEmail
          && !F.parents.some((x) => fullKey(x.first, x.last) === pKey)) {
        plan.addParents.push({ familyRef: F.ref, contactId: c.contactId, parent: { ...primary, is_primary: false, ghl_contact_id: c.contactId } });
        F.parents.push({ id: null, contactId: c.contactId, email: primary.email, first: primary.first_name, last: primary.last_name, isPrimary: false });
        link(byEmail, pEm, F.ref);
        link(byContact, c.contactId, F.ref);
      }
      for (const s of m.students) {
        if (statuses.get(s) !== 'enrolled') continue;
        const inF = F.students.find((x) => fullKey(x.first, x.last) === fullKey(s.first_name, s.last_name));
        if (inF) { if (inF.enrollmentStatus !== 'enrolled') upgrade(inF); else plan.unchanged++; continue; }
        addStudentTo(F, s, c.contactId, m.parents.map((p) => ({ first: p.first_name, last: p.last_name })));
      }
      for (const p of m.parents) if (!p.is_primary) addCoParent(F, p, c.contactId, primary);
      return;
    }
    if (weakRefs.size > 0) {
      attention(`maybedup:${c.contactId}`,
        `Can't safely add ${label}'s family: a child with the same name (${m.students.map((s) => `${s.first_name} ${s.last_name}`).join(', ')}) is already on the roster but a date of birth is missing, so it may be the same child — add the date of birth on the contact in Growth Suite, or confirm it's a different child.`);
      return;
    }

    // ---- a genuinely new family ----
    if (m.students.length === 0) {
      attention(`nostudent:${c.contactId}`,
        `${label} has an Enrolled card ("${enrolled.map((k) => k.name).join('", "')}") but no child in the contact's Student fields — fill Student 1 First Name, Last Name and Date of Birth in Growth Suite; the family is created on the next sync.`);
      return;
    }
    const hazard = m.students.find((s) => isParentName(s, m.parents.map((p) => ({ first: p.first_name, last: p.last_name }))));
    if (hazard) {
      attention(`namehazard:${c.contactId}:${fullKey(hazard.first_name, hazard.last_name)}`,
        `${label}'s contact lists "${hazard.first_name} ${hazard.last_name}" as the student, exactly the parent's name — usually the parent's name typed into the Student fields. Correct Student First/Last Name in Growth Suite (if the child truly shares the parent's name, add "Jr." or a middle name); the family is created on the next sync.`);
      return;
    }
    if (![...statuses.values()].includes('enrolled')) {
      attention(`nomatch:${c.contactId}`,
        `${label}'s Enrolled card ("${enrolled.map((k) => k.name).join('", "')}") doesn't match any child on the contact (${m.students.map((s) => `${s.first_name} ${s.last_name}`).join(', ')}) — rename the card to the child's name or fix the Student fields.`);
      return;
    }
    if (!lc(primary?.email)) {
      attention(`noemail:${c.contactId}`,
        `${label} is enrolled but the contact has no email address, so no portal login can be created — add their email in Growth Suite.`);
      return;
    }
    const family: MappedFamily = {
      ...m,
      students: m.students.map((s) => ({ ...s, enrollment_status: statuses.get(s) ?? '' })),
    };
    const ref = `new:${c.contactId}`;
    plan.createFamilies.push({ ref, contactId: c.contactId, family });
    const F = fam(ref);
    F.name = family.display_name;
    for (const p of family.parents) {
      F.parents.push({ id: null, contactId: p.ghl_contact_id, email: p.email, first: p.first_name, last: p.last_name, isPrimary: p.is_primary });
      link(byEmail, lc(p.email), ref);
      link(byContact, p.ghl_contact_id, ref);
    }
    for (const s of family.students) {
      F.students.push({ id: null, first: s.first_name, last: s.last_name, preferred: s.preferred_name, dob: s.date_of_birth, enrollmentId: null, enrollmentStatus: s.enrollment_status || null });
    }
    secondParentCheck(F, c);
  };

  for (const c of input.candidates) {
    const enrolled = c.cards.filter(isEnrolledCard);
    if (enrolled.length === 0) continue;
    const linked = [...(byContact.get(c.contactId) ?? [])];
    if (linked.length > 1) { plan.unchanged += enrolled.length; continue; } // one contact in several families: a person's call
    if (linked.length === 1) augmentLinked(fam(linked[0]), c, enrolled);
    else handleUnlinked(c, enrolled);
  }
  return plan;
}
