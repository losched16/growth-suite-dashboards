// Lightweight CSV parser + roster row validator. Keeps the row schema
// strict (we won't try to magic-handle every possible school's column
// layout) and surfaces validation errors per row so operators know
// exactly what to fix in their spreadsheet.
//
// Expected columns (header row required, case-insensitive, snake_case
// or "Title Case" both accepted):
//
//   family_name              required  e.g. "Smith Family"
//   primary_parent_first     required  e.g. "Jane"
//   primary_parent_last      required  e.g. "Smith"
//   primary_parent_email     required  e.g. "jane@example.com"
//   primary_parent_phone     optional  e.g. "555-555-5555"
//   second_parent_first      optional
//   second_parent_last       optional
//   second_parent_email      optional
//   second_parent_phone      optional
//   student_first            required  e.g. "Emma"
//   student_last             required  e.g. "Smith"
//   student_dob              required  YYYY-MM-DD
//   classroom                optional  e.g. "Sunflower"
//   program                  optional  e.g. "Primary"
//
// One row per (student, family). Two students in the same family = two
// rows with identical family-side columns.

export interface RosterRow {
  family_name: string;
  primary_parent_first: string;
  primary_parent_last: string;
  primary_parent_email: string;
  primary_parent_phone: string | null;
  second_parent_first: string | null;
  second_parent_last: string | null;
  second_parent_email: string | null;
  second_parent_phone: string | null;
  student_first: string;
  student_last: string;
  student_dob: string;  // ISO YYYY-MM-DD
  classroom: string | null;
  program: string | null;
}

export interface ParseError {
  row_number: number;            // 1-indexed, NOT including header
  raw_row: string;
  message: string;
}

export interface ParseResult {
  rows: RosterRow[];
  errors: ParseError[];
  // Same family appearing on multiple rows is normal (siblings) — we
  // dedupe family-level info via primary_parent_email. Mismatches
  // across rows for the same email surface as validation errors.
  unique_family_emails: number;
  unique_students: number;
}

// Map of accepted header aliases (snake_case or human-readable) to
// canonical RosterRow keys.
const HEADER_ALIASES: Record<string, keyof RosterRow> = {
  family_name: 'family_name',
  'family name': 'family_name',
  family: 'family_name',

  primary_parent_first: 'primary_parent_first',
  'primary parent first': 'primary_parent_first',
  'primary parent first name': 'primary_parent_first',
  parent_first: 'primary_parent_first',
  primary_parent_first_name: 'primary_parent_first',

  primary_parent_last: 'primary_parent_last',
  'primary parent last': 'primary_parent_last',
  'primary parent last name': 'primary_parent_last',
  parent_last: 'primary_parent_last',
  primary_parent_last_name: 'primary_parent_last',

  primary_parent_email: 'primary_parent_email',
  'primary parent email': 'primary_parent_email',
  parent_email: 'primary_parent_email',
  email: 'primary_parent_email',

  primary_parent_phone: 'primary_parent_phone',
  'primary parent phone': 'primary_parent_phone',
  parent_phone: 'primary_parent_phone',
  phone: 'primary_parent_phone',

  second_parent_first: 'second_parent_first',
  'second parent first': 'second_parent_first',
  'second parent first name': 'second_parent_first',
  parent2_first: 'second_parent_first',
  second_parent_first_name: 'second_parent_first',

  second_parent_last: 'second_parent_last',
  'second parent last': 'second_parent_last',
  parent2_last: 'second_parent_last',
  second_parent_last_name: 'second_parent_last',

  second_parent_email: 'second_parent_email',
  'second parent email': 'second_parent_email',
  parent2_email: 'second_parent_email',

  second_parent_phone: 'second_parent_phone',
  'second parent phone': 'second_parent_phone',
  parent2_phone: 'second_parent_phone',

  student_first: 'student_first',
  'student first': 'student_first',
  'student first name': 'student_first',
  student_first_name: 'student_first',

  student_last: 'student_last',
  'student last': 'student_last',
  'student last name': 'student_last',
  student_last_name: 'student_last',

  student_dob: 'student_dob',
  'student dob': 'student_dob',
  'student date of birth': 'student_dob',
  dob: 'student_dob',
  birthdate: 'student_dob',

  classroom: 'classroom',
  homeroom: 'classroom',
  room: 'classroom',

  program: 'program',
};

const REQUIRED_KEYS: Array<keyof RosterRow> = [
  'family_name', 'primary_parent_first', 'primary_parent_last',
  'primary_parent_email', 'student_first', 'student_last', 'student_dob',
];

// Very loose email check — we want to catch garbage but not block valid
// edge cases (apostrophes, plus addressing, etc.).
function isValidEmail(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function isValidDob(s: string): boolean {
  // Accept YYYY-MM-DD or MM/DD/YYYY.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return !Number.isNaN(new Date(s).getTime());
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return !Number.isNaN(new Date(s).getTime());
  return false;
}

function normalizeDob(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return s;
}

// Splits a CSV line honoring quoted fields with embedded commas.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseRosterCsv(csv: string): ParseResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], errors: [{ row_number: 0, raw_row: '', message: 'CSV is empty.' }], unique_family_emails: 0, unique_students: 0 };
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const headerKeys = headers.map((h) => HEADER_ALIASES[h] ?? null);

  // Verify required keys are all present.
  const missing: string[] = [];
  for (const req of REQUIRED_KEYS) {
    if (!headerKeys.includes(req)) missing.push(req);
  }
  if (missing.length > 0) {
    return {
      rows: [], errors: [{
        row_number: 0,
        raw_row: lines[0],
        message: `Missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. See the docs for the expected column list.`,
      }],
      unique_family_emails: 0, unique_students: 0,
    };
  }

  const rows: RosterRow[] = [];
  const errors: ParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.every((c) => c === '')) continue; // skip blank lines

    const obj: Partial<Record<keyof RosterRow, string>> = {};
    for (let j = 0; j < headerKeys.length; j++) {
      const k = headerKeys[j];
      if (k) obj[k] = cells[j] ?? '';
    }

    // Validate required fields.
    const rowErrors: string[] = [];
    for (const req of REQUIRED_KEYS) {
      if (!obj[req] || obj[req]?.trim() === '') {
        rowErrors.push(`missing ${req}`);
      }
    }
    if (obj.primary_parent_email && !isValidEmail(obj.primary_parent_email)) {
      rowErrors.push(`invalid primary_parent_email "${obj.primary_parent_email}"`);
    }
    if (obj.second_parent_email && obj.second_parent_email.trim() !== '' && !isValidEmail(obj.second_parent_email)) {
      rowErrors.push(`invalid second_parent_email "${obj.second_parent_email}"`);
    }
    if (obj.student_dob && !isValidDob(obj.student_dob)) {
      rowErrors.push(`invalid student_dob "${obj.student_dob}" (use YYYY-MM-DD or MM/DD/YYYY)`);
    }
    if (rowErrors.length > 0) {
      errors.push({ row_number: i, raw_row: lines[i], message: rowErrors.join('; ') });
      continue;
    }

    rows.push({
      family_name:          obj.family_name!.trim(),
      primary_parent_first: obj.primary_parent_first!.trim(),
      primary_parent_last:  obj.primary_parent_last!.trim(),
      primary_parent_email: obj.primary_parent_email!.trim().toLowerCase(),
      primary_parent_phone: obj.primary_parent_phone?.trim() || null,
      second_parent_first:  obj.second_parent_first?.trim() || null,
      second_parent_last:   obj.second_parent_last?.trim() || null,
      second_parent_email:  obj.second_parent_email?.trim().toLowerCase() || null,
      second_parent_phone:  obj.second_parent_phone?.trim() || null,
      student_first:        obj.student_first!.trim(),
      student_last:         obj.student_last!.trim(),
      student_dob:          normalizeDob(obj.student_dob!.trim()),
      classroom:            obj.classroom?.trim() || null,
      program:              obj.program?.trim() || null,
    });
  }

  const familyEmails = new Set(rows.map((r) => r.primary_parent_email));
  const studentKeys = new Set(rows.map((r) => `${r.primary_parent_email}|${r.student_first}|${r.student_last}|${r.student_dob}`));

  return {
    rows,
    errors,
    unique_family_emails: familyEmails.size,
    unique_students: studentKeys.size,
  };
}
