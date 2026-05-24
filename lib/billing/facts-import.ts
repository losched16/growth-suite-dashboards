// FACTS CSV import logic. Generic — works for any school that
// receives a FACTS export and wants to push amounts into our tuition
// system. Schools configure column mappings once (see
// `school_facts_import_mappings`), then re-run yearly.
//
// Standard schema fields we extract from a CSV row:
//
//   family_account_ref   stable family identifier from FACTS
//                         (account number, etc.) — match-helper
//   student_first        student first name
//   student_last         student last name
//   student_grade        free-text grade label
//   payer_email          primary payer's email (preferred match key)
//   payer_first          payer first name
//   payer_last           payer last name
//   annual_tuition       canonical annual tuition in dollars
//                         (already includes/excludes adjustments per
//                         the school's FACTS setup — usually the
//                         "all in" number)
//   sibling_discount     sibling discount applied (dollars, negative
//                         or positive number depending on the school)
//   scholarship_amount   scholarship/FA amount (dollars)
//   plan_name            free-text plan name to match against
//                         payment_plans.display_name (using the
//                         per-school plan_name_aliases map)
//
// Schools can map ANY column to ANY of these. If a column isn't
// mapped, we just don't capture that field (no error).
//
// Matching algorithm (rows → students):
//   1. Match by payer email (case-insensitive) JOIN students name
//   2. If only one student matches name in family → done
//   3. If multiple → match by grade
//   4. If still ambiguous → log error, skip row
//
// Idempotent — re-running an import creates or UPDATES enrollment
// rows, never duplicates.

import { query } from '@/lib/db';

export interface FactsCsvRow {
  rowNumber: number;       // for error reporting
  raw: Record<string, string>;
}

export interface MappedRow {
  rowNumber: number;
  family_account_ref?: string;
  student_first?: string;
  student_last?: string;
  student_grade?: string;
  payer_email?: string;
  payer_first?: string;
  payer_last?: string;
  annual_tuition_cents?: number;
  sibling_discount_cents?: number;
  scholarship_amount_cents?: number;
  plan_name?: string;
}

export interface FieldMapping {
  [our_schema_field: string]: string;  // csv header
}

export interface ImportRowOutcome {
  rowNumber: number;
  status: 'inserted' | 'updated' | 'skipped' | 'errored';
  reason?: string;
  enrollment_id?: string;
  student_id?: string;
  student_name?: string;
}

const STANDARD_FIELDS = [
  'family_account_ref',
  'student_first',
  'student_last',
  'student_grade',
  'payer_email',
  'payer_first',
  'payer_last',
  'annual_tuition',
  'sibling_discount',
  'scholarship_amount',
  'plan_name',
] as const;
export type StandardField = typeof STANDARD_FIELDS[number];

// Parse a CSV string into an array of header + row objects. Handles
// quoted values with embedded commas. Not full RFC 4180 — we don't
// support multi-line cells (no FACTS export has those).
export function parseCsv(csv: string): { headers: string[]; rows: FactsCsvRow[] } {
  const lines = csv.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else cur += ch;
      } else {
        if (ch === ',') { out.push(cur); cur = ''; }
        else if (ch === '"') inQuote = true;
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headers = splitLine(lines[0]);
  const rows: FactsCsvRow[] = lines.slice(1).map((line, i) => {
    const cells = splitLine(line);
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => { raw[h] = cells[j] ?? ''; });
    return { rowNumber: i + 2, raw };  // +2: row 1 is header, rows start at 2
  });
  return { headers, rows };
}

// Parse a dollar value (e.g. "$16,250.00", "16250", "-$630.32") to cents.
// Returns null for unparseable values; 0 for "$0.00", "0", etc.
export function parseDollarsToCents(v: string | undefined | null): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned.toUpperCase() === 'NA') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Take parsed CSV rows + a field mapping, produce mapped rows ready
// for the matching step.
export function mapRows(rows: FactsCsvRow[], mapping: FieldMapping): MappedRow[] {
  return rows.map((row) => {
    const m: MappedRow = { rowNumber: row.rowNumber };
    for (const field of STANDARD_FIELDS) {
      const header = mapping[field];
      if (!header) continue;
      const raw = row.raw[header];
      if (raw == null || raw === '') continue;
      if (field === 'annual_tuition') m.annual_tuition_cents = parseDollarsToCents(raw) ?? undefined;
      else if (field === 'sibling_discount') m.sibling_discount_cents = parseDollarsToCents(raw) ?? undefined;
      else if (field === 'scholarship_amount') m.scholarship_amount_cents = parseDollarsToCents(raw) ?? undefined;
      else (m as unknown as Record<string, string | number | undefined>)[field] = String(raw).trim();
    }
    return m;
  });
}

interface StudentLookupRow {
  student_id: string;
  family_id: string;
  student_first: string;
  student_last: string;
  preferred: string | null;
  grade_level: string | null;
  parent_emails: string[];
}

// Match a mapped row to a student in our DB. Returns the student_id
// or an error reason. Pulls all active students for the school once
// up front and matches in memory (faster than per-row queries).
export function matchRowToStudent(
  row: MappedRow,
  candidates: StudentLookupRow[],
): { student_id?: string; family_id?: string; reason?: string } {
  const fn = (row.student_first ?? '').trim().toLowerCase();
  const ln = (row.student_last ?? '').trim().toLowerCase();
  const email = (row.payer_email ?? '').trim().toLowerCase();

  if (!fn && !ln) return { reason: 'missing student name' };

  let candidatesByName = candidates.filter((c) => {
    const cFn = (c.student_first ?? '').toLowerCase();
    const cPref = (c.preferred ?? '').toLowerCase();
    const cLn = (c.student_last ?? '').toLowerCase();
    return (cFn === fn || cPref === fn) && cLn === ln;
  });

  if (candidatesByName.length === 0) return { reason: 'no student found with that name' };
  if (candidatesByName.length === 1) {
    const c = candidatesByName[0];
    return { student_id: c.student_id, family_id: c.family_id };
  }

  // Multiple students with the same name. Disambiguate by email match.
  if (email) {
    const matches = candidatesByName.filter((c) =>
      (c.parent_emails ?? []).some((e) => (e ?? '').toLowerCase() === email),
    );
    if (matches.length === 1) {
      return { student_id: matches[0].student_id, family_id: matches[0].family_id };
    }
    candidatesByName = matches.length > 0 ? matches : candidatesByName;
  }

  // Disambiguate by grade label substring
  if (row.student_grade) {
    const grade = row.student_grade.toLowerCase();
    const matches = candidatesByName.filter((c) =>
      (c.grade_level ?? '').toLowerCase().includes(grade)
      || grade.includes((c.grade_level ?? '').toLowerCase()),
    );
    if (matches.length === 1) {
      return { student_id: matches[0].student_id, family_id: matches[0].family_id };
    }
  }

  return { reason: `ambiguous: ${candidatesByName.length} students match name "${fn} ${ln}"` };
}

// Bulk-load all students + their parents' emails for matching.
export async function loadStudentLookup(schoolId: string): Promise<StudentLookupRow[]> {
  const { rows } = await query<StudentLookupRow>(
    `SELECT s.id AS student_id, s.family_id,
            s.first_name AS student_first, s.last_name AS student_last,
            s.preferred_name AS preferred,
            s.metadata->>'grade_level' AS grade_level,
            COALESCE(
              (SELECT array_agg(LOWER(p.email)) FROM parents p
                WHERE p.family_id = s.family_id AND p.email IS NOT NULL),
              ARRAY[]::text[]
            ) AS parent_emails
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'`,
    [schoolId],
  );
  return rows;
}

// Match a plan_name from the CSV against this school's payment_plans.
// Uses an alias map (e.g. { "Monthly Payment Plan": "monthly" }) if
// configured, else falls back to fuzzy display_name match.
export function matchPlanName(
  csvPlanName: string | undefined,
  schoolPlans: Array<{ id: string; slug: string; display_name: string }>,
  aliases: Record<string, string>,
): string | null {
  if (!csvPlanName) return null;
  const norm = csvPlanName.trim().toLowerCase();
  // Alias exact match
  for (const [alias, slug] of Object.entries(aliases)) {
    if (alias.toLowerCase() === norm) {
      return schoolPlans.find((p) => p.slug === slug)?.id ?? null;
    }
  }
  // Fuzzy display_name match
  for (const p of schoolPlans) {
    if (p.display_name.toLowerCase().includes(norm) || norm.includes(p.display_name.toLowerCase())) {
      return p.id;
    }
    if (p.slug.toLowerCase() === norm) return p.id;
  }
  return null;
}
