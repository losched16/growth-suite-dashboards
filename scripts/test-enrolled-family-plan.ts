// Unit tests for lib/sync/enrolled-family-plan.ts (the pure planner behind the
// enrolled-family sync). No test runner in this repo — run with:
//   npx esbuild scripts/test-enrolled-family-plan.ts --bundle --platform=node --outfile=<tmp>/t.mjs && node <tmp>/t.mjs
import { planEnrolledFamilySync, cardNames, type PlanInput } from '../lib/sync/enrolled-family-plan';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FAIL ' + name + (extra ? '  → ' + extra : '')); } };

const P = (first: string, last: string, email: string | null, primary: boolean, contactId: string | null = null) =>
  ({ ghl_contact_id: contactId, first_name: first, last_name: last, email, phone: null, is_primary: primary, role: 'parent' });
const S = (first: string, last: string, dob: string | null = null) =>
  ({ first_name: first, last_name: last, preferred_name: null, date_of_birth: dob, gender: null, enrollment_status: 'enrolled',
     classroom_name: null, grade_level: null, lead_teacher_name: null, schedule: null, academic_year: '2025-26', enrolled_at: null, metadata: {} });
const M = (parents: any[], students: any[], name = 'X Family') => ({ display_name: name, notes: null, status: 'active', parents, students });
const card = (id: string, name: string, funnel = 'enrolled', status = 'open') => ({ id, name, funnel, status });
const cand = (contactId: string, contactName: string, mapped: any, cards: any[], wants = false) => ({ contactId, contactName, mapped, cards, wantsSecondParent: wants });
const inp = (o: Partial<PlanInput>): PlanInput => ({ candidates: [], primaryMappedByFamily: new Map(), familyNames: new Map(), parents: [], students: [], ...o } as PlanInput);
const rp = (id: string, familyId: string, first: string, last: string, email: string | null, isPrimary: boolean, contactId: string | null = null) =>
  ({ id, familyId, contactId, email, firstName: first, lastName: last, isPrimary });
const rs = (id: string, familyId: string, first: string, last: string, dob: string | null = null, status: string | null = 'enrolled') =>
  ({ id, familyId, firstName: first, lastName: last, preferredName: null, dob, enrollmentId: 'e-' + id, enrollmentStatus: status });
const has = (p: any, prefix: string) => p.attention.some((a: any) => a.key.startsWith(prefix));
const nothing = (p: any) => !p.createFamilies.length && !p.addStudents.length && !p.addParents.length && !p.upgradeEnrollments.length && !p.fillParentEmails.length;

console.log('— new families —');
{ // 1 Gauguet
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c1', 'Stefanie Gauguet', M([P('Stefanie', 'Gauguet', 's@x.com', true, 'c1'), P('Jean-Marc', 'Gauguet', 'jm@x.com', false)], [S('Naia', 'Gauguet', '2015-08-08')], 'Gauguet Family'), [card('k1', 'Naia Gauguet')])] }));
  ok('Gauguet: family created', p.createFamilies.length === 1);
  ok('Gauguet: Naia enrolled, both parents kept', p.createFamilies[0]?.family.students[0].enrollment_status === 'enrolled' && p.createFamilies[0]?.family.parents.length === 2);
  ok('Gauguet: no attention', p.attention.length === 0, JSON.stringify(p.attention));
}
{ // 2 Koksal hazard (the real Mus incident)
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c2', 'Koksal Mus', M([P('Koksal', 'Mus', 'k@x.com', true, 'c2')], [S('Koksal', 'Mus', '2023-10-28')]), [card('k2', 'Jaylene Mus')])] }));
  ok('Mus (parent name in student field): NOT created', p.createFamilies.length === 0);
  ok('Mus: namehazard alert', has(p, 'namehazard:'));
}
{ // 3 Bourette: parent-named card, single child, second parent requested
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c3', 'Micayla Bourette', M([P('Micayla', 'Bourette', 'm@x.com', true, 'c3')], [S('Miles', 'Bourette', '2024-07-07')]), [card('k3', 'Micayla Bourette')], true)] }));
  ok('Bourette (parent-named card, 1 child): created via single-card rule', p.createFamilies.length === 1 && p.createFamilies[0].family.students[0].enrollment_status === 'enrolled');
  ok('Bourette: second-parent-missing alert', has(p, 'p2missing:'));
}
{ // 4 parent-named card, two kids → can't tell which is enrolled
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c4', 'Ann Lee', M([P('Ann', 'Lee', 'a@x.com', true, 'c4')], [S('Bo', 'Lee'), S('Cy', 'Lee')]), [card('k4', 'Ann Lee')])] }));
  ok('parent-named card + 2 kids: not created, nomatch alert', p.createFamilies.length === 0 && has(p, 'nomatch:'));
}
{ // 5, 6 no student / no email
  const p5 = planEnrolledFamilySync(inp({ candidates: [cand('c5', 'Dee Ray', M([P('Dee', 'Ray', 'd@x.com', true, 'c5')], []), [card('k5', 'Eli Ray')])] }));
  ok('no student data: nostudent alert, nothing created', p5.createFamilies.length === 0 && has(p5, 'nostudent:'));
  const p6 = planEnrolledFamilySync(inp({ candidates: [cand('c6', 'Fay Ott', M([P('Fay', 'Ott', null, true, 'c6')], [S('Gus', 'Ott')]), [card('k6', 'Gus Ott')])] }));
  ok('no email: noemail alert, nothing created', p6.createFamilies.length === 0 && has(p6, 'noemail:'));
}
{ // 19 same-name child, different DOB → a different child → create
  const p = planEnrolledFamilySync(inp({
    parents: [rp('p1', 'F1', 'Old', 'Smith', 'o@x.com', true, 'cz')], students: [rs('s1', 'F1', 'Emma', 'Smith', '2015-01-01')],
    candidates: [cand('c19', 'New Smith', M([P('New', 'Smith', 'n@x.com', true, 'c19')], [S('Emma', 'Smith', '2019-06-06')]), [card('k19', 'Emma Smith')])] }));
  ok('same name, different DOB: created as a new family', p.createFamilies.length === 1);
}
{ // 18 same-name child, DOB missing → might be the same child
  const p = planEnrolledFamilySync(inp({
    parents: [rp('p1', 'F1', 'Old', 'Smith', 'o@x.com', true, 'cz')], students: [rs('s1', 'F1', 'Emma', 'Smith', null)],
    candidates: [cand('c18', 'New Smith', M([P('New', 'Smith', 'n@x.com', true, 'c18')], [S('Emma', 'Smith', '2019-06-06')]), [card('k18', 'Emma Smith')])] }));
  ok('same name, DOB unknown: NOT created, maybedup alert', p.createFamilies.length === 0 && has(p, 'maybedup:'));
}
{ // 26 Jr. sharing a parent's name
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c26', 'Robert Curzan', M([P('Robert', 'Curzan', 'r@x.com', true, 'c26')], [S('Robert', 'Curzan', '2018-01-01')]), [card('k26', 'Robert Curzan')])] }));
  ok('child sharing parent name exactly: held for a person (namehazard)', p.createFamilies.length === 0 && has(p, 'namehazard:'));
}

console.log('— parent-2 card artifacts (the 68 cards) —');
{ // 7
  const p = planEnrolledFamilySync(inp({ students: [rs('s1', 'F1', 'Simon', 'Kenary')], parents: [rp('p1', 'F1', 'Sarah', 'Kenary', 'sk@x.com', true, 'cs')],
    candidates: [cand('c7', 'Sam Kenary', null, [card('k7', 'Simon Kenary')])] }));
  ok('P2 contact, child on roster: nothing, no alert', nothing(p) && p.attention.length === 0 && p.unchanged === 1);
}
{ // 8
  const p = planEnrolledFamilySync(inp({ candidates: [cand('c8', 'Zed Parent2', null, [card('k8', 'Unknown Kid')])] }));
  ok('P2 contact, child NOT on roster: card alert, nothing created', nothing(p) && has(p, 'card:'));
}

console.log('— existing families: siblings, upgrades —');
const fam1 = { parents: [rp('p1', 'F1', 'Pat', 'Xu', 'pat@x.com', true, 'c9')], students: [rs('s1', 'F1', 'Amy', 'Xu', '2019-01-01')] };
{ // 9
  const p = planEnrolledFamilySync(inp({ ...fam1, candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9')], [S('Amy', 'Xu', '2019-01-01'), S('Ben', 'Xu', '2022-02-02')]), [card('k9a', 'Amy Xu'), card('k9b', 'Ben Xu')])] }));
  ok('new enrolled sibling added to the existing family', p.addStudents.length === 1 && p.addStudents[0].student.first_name === 'Ben' && p.addStudents[0].familyRef === 'F1');
  ok('no new family for an existing contact', p.createFamilies.length === 0);
}
{ // 10, 11
  const p10 = planEnrolledFamilySync(inp({ ...fam1, candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9')], [S('Amy', 'Xu'), S('Ben', 'Xu')]), [card('k9a', 'Amy Xu'), card('k9b', 'Ben Xu', 'inquiry')])] }));
  ok('sibling only at Inquiry: not added', p10.addStudents.length === 0);
  const p11 = planEnrolledFamilySync(inp({ ...fam1, candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9')], [S('Amy', 'Xu'), S('Ben', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('sibling with no card: not added', p11.addStudents.length === 0);
}
{ // 12 prospect → enrolled
  const p = planEnrolledFamilySync(inp({ parents: fam1.parents, students: [rs('s1', 'F1', 'Amy', 'Xu', null, 'tour_scheduled')],
    candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9')], [S('Amy', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('prospect whose card reached Enrolled: upgraded', p.upgradeEnrollments.length === 1 && p.upgradeEnrollments[0].from === 'tour_scheduled');
}
{ // 28 sibling already in another family
  const p = planEnrolledFamilySync(inp({ parents: [...fam1.parents, rp('p9', 'F9', 'Q', 'Z', 'q@x.com', true, 'cq')],
    students: [...fam1.students, rs('s9', 'F9', 'Ben', 'Xu', null)],
    candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9')], [S('Amy', 'Xu'), S('Ben', 'Xu', '2022-02-02')]), [card('k9a', 'Amy Xu'), card('k9b', 'Ben Xu')])] }));
  ok('sibling possibly in another family: held (childelsewhere alert)', p.addStudents.length === 0 && has(p, 'childelsewhere:'));
}
{ // 23 sibling whose card sits on the parent-2 contact; data on the primary's record
  const primary = M([P('Mom', 'Lo', 'mom@x.com', true, 'cm')], [S('Old', 'Lo'), S('New', 'Lo', '2023-03-03')]);
  const p = planEnrolledFamilySync(inp({
    parents: [rp('pm', 'F2', 'Mom', 'Lo', 'mom@x.com', true, 'cm'), rp('pd', 'F2', 'Dad', 'Lo', 'dad@x.com', false, 'cd')],
    students: [rs('so', 'F2', 'Old', 'Lo')],
    primaryMappedByFamily: new Map([['F2', primary as any]]),
    candidates: [cand('cd', 'Dad Lo', null, [card('kn', 'New Lo')])] }));
  ok('sibling carded on the parent-2 contact: added from the primary record', p.addStudents.length === 1 && p.addStudents[0].student.first_name === 'New');
}

console.log('— co-parents —');
{ // 13 new P2 in fields
  const p = planEnrolledFamilySync(inp({ ...fam1, candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9'), P('Lee', 'Xu', 'lee@x.com', false)], [S('Amy', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('co-parent entered in Parent 2 fields: added', p.addParents.length === 1 && p.addParents[0].parent.email === 'lee@x.com' && !p.addParents[0].parent.is_primary);
}
{ // 14 email change
  const p = planEnrolledFamilySync(inp({ parents: [...fam1.parents, rp('p2', 'F1', 'Ruth', 'Xu', 'old@x.com', false)], students: fam1.students,
    candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9'), P('Ruth', 'Xu', 'new@x.com', false)], [S('Amy', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('co-parent email CHANGE: never overwritten, alert instead', p.addParents.length === 0 && p.fillParentEmails.length === 0 && has(p, 'emailchange:'));
}
{ // 15 blank email filled
  const p = planEnrolledFamilySync(inp({ parents: [...fam1.parents, rp('p2', 'F1', 'Ruth', 'Xu', null, false)], students: fam1.students,
    candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9'), P('Ruth', 'Xu', 'ruth@x.com', false)], [S('Amy', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('co-parent on file with NO email: blank filled', p.fillParentEmails.length === 1 && p.fillParentEmails[0].parentId === 'p2' && p.addParents.length === 0);
}
{ // 16 P2 email belongs elsewhere
  const p = planEnrolledFamilySync(inp({ parents: [...fam1.parents, rp('p8', 'F8', 'Other', 'Pp', 'lee@x.com', true, 'co')], students: fam1.students,
    candidates: [cand('c9', 'Pat Xu', M([P('Pat', 'Xu', 'pat@x.com', true, 'c9'), P('Lee', 'Xu', 'lee@x.com', false)], [S('Amy', 'Xu')]), [card('k9a', 'Amy Xu')])] }));
  ok('P2 email already in another family: alert, not added', p.addParents.length === 0 && has(p, 'p2elsewhere:'));
}
{ // 17 co-parent's own contact (no P2 tag), DOB-confirmed child
  const p = planEnrolledFamilySync(inp({ parents: [rp('p1', 'F1', 'Mom', 'Yu', 'mom@x.com', true, 'cm')], students: [rs('s1', 'F1', 'Zoe', 'Yu', '2020-01-01')],
    candidates: [cand('cx', 'Dad Yu', M([P('Dad', 'Yu', 'dad@x.com', true, 'cx')], [S('Zoe', 'Yu', '2020-01-01')]), [card('kx', 'Zoe Yu')])] }));
  ok('co-parent contact with DOB-matched child: linked as co-parent, no 2nd family', p.createFamilies.length === 0 && p.addParents.length === 1 && p.addParents[0].parent.ghl_contact_id === 'cx');
}
{ // 22 split co-parents both new in the same run
  const k = card('kk', 'Kit Lo');
  const p = planEnrolledFamilySync(inp({ candidates: [
    cand('ca', 'Ann Lo', M([P('Ann', 'Lo', 'ann@x.com', true, 'ca')], [S('Kit', 'Lo', '2021-01-01')]), [k]),
    cand('cb', 'Bob Lo', M([P('Bob', 'Lo', 'bob@x.com', true, 'cb')], [S('Kit', 'Lo', '2021-01-01')]), [{ ...k, id: 'kk2' }]),
  ] }));
  ok('split co-parents new in one run: ONE family + co-parent linked', p.createFamilies.length === 1 && p.addParents.length === 1 && p.addParents[0].familyRef === 'new:ca');
}

console.log('— safety edges —');
{ // 20 contact in 2 families
  const p = planEnrolledFamilySync(inp({ parents: [rp('a', 'FA', 'J', 'Q', 'j@x.com', true, 'cq'), rp('b', 'FB', 'J', 'Q', 'j@x.com', true, 'cq')],
    candidates: [cand('cq', 'J Q', M([P('J', 'Q', 'j@x.com', true, 'cq')], [S('K', 'Q')]), [card('kq', 'K Q')])] }));
  ok('contact linked to 2 families: no automatic change', nothing(p));
}
{ // 21 lost card
  const p = planEnrolledFamilySync(inp({ candidates: [cand('cl', 'Lu Lu', M([P('Lu', 'Lu', 'l@x.com', true, 'cl')], [S('Mo', 'Lu')]), [card('kl', 'Mo Lu', 'enrolled', 'lost')])] }));
  ok('Lost card at an Enrolled stage: ignored', nothing(p) && p.attention.length === 0);
}
{ // name matching
  ok('nickname in card title matches ("Ruby Josephine “Jojo” Birke")', cardNames('Ruby Josephine “Jojo” Birke', 'Ruby', 'Birke'));
  ok("apostrophe/hyphen names match (D'Ambrosio, Arruda-Leuppert)", cardNames("Marco D'Ambrosio", 'Marco', "D'Ambrosio") && cardNames('Anton Arruda-Leuppert', 'Anton', 'Arruda-Leuppert'));
  ok('siblings told apart by first name', !cardNames('Ben Xu', 'Amy', 'Xu'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
