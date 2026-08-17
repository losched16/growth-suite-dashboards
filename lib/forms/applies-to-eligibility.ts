// Shared "does this form apply to this student/family?" evaluator for
// office-side surfaces (Forms Tracker, per-form submissions page). Mirrors
// the parent portal's studentMatchesAppliesTo (parent-portal
// lib/forms/applies-to.ts) so what the office counts as "not yet
// submitted" is exactly the set of families who can actually SEE the form.
//
// Semantics: tag_exclude / metadata_exclude veto first; then any inclusion
// criterion admits (OR): student_ids, program substring, family tag, or a
// metadata value (grade_level etc.). A rule with no evaluable inclusion
// criteria = everyone.

export interface AppliesToRule {
  student_ids?: string[];
  program_match?: string[];
  tag_match?: string[];
  tag_exclude?: string[];
  metadata_match?: Record<string, string[]>;
  metadata_exclude?: Record<string, string[]>;
  // Not evaluable here (need enrollment data); treated as "no criterion".
  tuition_grid_match?: string[];
  addon_keys?: string[];
}

export interface EligibilityStudent {
  student_id: string;
  family_id: string;
  metadata: Record<string, unknown> | null;
}

export function ruleIsEmpty(rule: AppliesToRule): boolean {
  return !(
    (rule.student_ids && rule.student_ids.length > 0) ||
    (rule.program_match && rule.program_match.length > 0) ||
    (rule.tag_match && rule.tag_match.length > 0) ||
    (rule.metadata_match && Object.keys(rule.metadata_match).length > 0)
  );
}

export function ruleExcludesFamily(rule: AppliesToRule | null | undefined, familyTags: Set<string>): boolean {
  if (!rule?.tag_exclude?.length) return false;
  return rule.tag_exclude.some((t) => familyTags.has(t.toLowerCase()));
}

export function studentMatchesRule(
  rule: AppliesToRule | null | undefined,
  student: EligibilityStudent,
  familyTags: Set<string>,
): boolean {
  if (!rule) return true;
  if (ruleExcludesFamily(rule, familyTags)) return false;
  if (rule.metadata_exclude) {
    for (const [k, vals] of Object.entries(rule.metadata_exclude)) {
      const v = String(student.metadata?.[k] ?? '').toLowerCase();
      if (v && vals.some((vv) => vv.toLowerCase() === v)) return false;
    }
  }
  if (ruleIsEmpty(rule)) return true;
  if (rule.student_ids?.includes(student.student_id)) return true;
  if (rule.program_match?.length) {
    const prog = String(student.metadata?.program ?? student.metadata?.program_name ?? '').toLowerCase();
    if (prog && rule.program_match.some((s) => prog.includes(s.toLowerCase()))) return true;
  }
  if (rule.tag_match?.length) {
    if (rule.tag_match.some((t) => familyTags.has(t.toLowerCase()))) return true;
  }
  if (rule.metadata_match) {
    for (const [k, vals] of Object.entries(rule.metadata_match)) {
      const v = String(student.metadata?.[k] ?? '').toLowerCase();
      if (v && vals.some((vv) => vv.toLowerCase() === v)) return true;
    }
  }
  return false;
}

// Family-level form: applies when not excluded AND (rule empty, a family
// tag matches, or ANY of the family's students matches).
export function familyMatchesRule(
  rule: AppliesToRule | null | undefined,
  familyStudents: EligibilityStudent[],
  familyTags: Set<string>,
): boolean {
  if (!rule) return true;
  if (ruleExcludesFamily(rule, familyTags)) return false;
  if (ruleIsEmpty(rule)) return true;
  return familyStudents.some((s) => studentMatchesRule(rule, s, familyTags));
}
