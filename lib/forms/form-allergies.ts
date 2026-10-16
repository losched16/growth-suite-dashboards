// Roster allergy text built from portal-form answers.
//
// Schools whose GHL has no single allergy field (Wooster: a free-text
// allergen list + Yes/No flags per allergy type, per student slot) left the
// roster's Allergy column, its "Allergies only" filter and the allergies-
// by-classroom view empty while parents had answered on the forms. With
// settings.roster_allergy_from_forms on, every allergy-related question on
// the school's active forms feeds one line per student:
//
//   "⚠ Anaphylaxis · EpiPen · Food, Pollen — Tree nuts, mold"
//
// Per-student forms first; a family-wide answer (one "Allergies" box for
// the whole family) is used only when the child has nothing of their own,
// and is labelled as such — it may describe a sibling.

import { buildStudentReport } from '@/lib/forms/student-report';

const MATCH = /allerg|anaphyl|epi-?pen/i;
// "none", "n/a", "no known allergies", "none that we know of", …
const NONE = /^(no|none|n\/?a|na|nka|nkda|nothing|nope|not applicable|unknown|no known|none known|no allergies|-+|\.)\b|none (that )?(we )?(are )?(know|aware)|^none of knowledge/i;
const SEVERE = /anaphyl|epi-?pen/i;

export interface FormAllergy {
  text: string | null;   // display line (null = flagged but no detail)
  flagged: boolean;      // any allergy indicated at all
}

// "Health Conditions: Severe Stinging Insect Allergies (if local…)" → "Stinging insect"
function shortLabel(label: string): string {
  const core = label.replace(/^.*?:\s*/, '').replace(/\s*\(.*$/, '').replace(/\bsevere\s+/i, '')
    .replace(/\s*allerg(y|ies)\b/i, '').trim();
  if (/anaphyl/i.test(core)) return 'Anaphylaxis';
  if (/epi-?pen/i.test(core)) return 'EpiPen';
  return core ? core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() : 'Allergy';
}

export async function resolveFormAllergies(schoolId: string): Promise<Map<string, FormAllergy>> {
  const out = new Map<string, FormAllergy>();
  const rep = await buildStudentReport({ schoolId, formIds: 'all', match: MATCH, scope: 'all' });
  if (rep.columns.length === 0) return out;
  const formById = new Map(rep.forms.map((f) => [f.id, f]));
  // free-text vs choice, from the form schema (earlier-form-only columns are text)
  const isChoice = (formId: string, key: string | null) => {
    const t = key ? formById.get(formId)?.fields.find((f) => f.key === key)?.type ?? '' : '';
    return /radio|select|checkbox|yes_?no|toggle/i.test(t);
  };

  for (const row of rep.rows) {
    const severe: string[] = [], types: string[] = [], texts: string[] = [], familyTexts: string[] = [];
    let flagged = false;
    for (const c of rep.columns) {
      const v = (row.values[c.id] ?? '').trim();
      if (!v || NONE.test(v) || v === 'None selected') continue;
      const perStudent = formById.get(c.formId)?.perStudent ?? true;
      const yes = /^yes\b/i.test(v);
      if (isChoice(c.formId, c.key) || (yes && v.length <= 4)) {
        // a family-wide Yes doesn't say which child
        if (!yes || !perStudent) continue;
        flagged = true;
        (SEVERE.test(c.label) ? severe : types).push(shortLabel(c.label));
        continue;
      }
      (perStudent ? texts : familyTexts).push(v);
      if (perStudent) flagged = true;
    }
    const uniq = (a: string[]) => [...new Map(a.map((x) => [x.toLowerCase().replace(/\W+/g, ''), x])).values()];
    const parts = [severe.length ? `⚠ ${uniq(severe).join(' · ')}` : '', uniq(types).join(', '), uniq(texts).join(' / ')].filter(Boolean);
    let text = parts.length ? parts.join(' — ') : null;
    if (!text && familyTexts.length) {
      text = `Family form: ${uniq(familyTexts).join(' / ')}`;
      flagged = true;
    }
    if (flagged || text) out.set(row.studentId, { text, flagged: true });
  }
  return out;
}
