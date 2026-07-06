// CSV migration mapping engine.
//
// A new school arrives with a spreadsheet export from their old system (FACTS,
// TADS, Brightwheel, a plain roster). This engine:
//   1. parses the CSV (RFC4180-ish: quotes, escaped quotes, embedded newlines),
//   2. proposes a column → GHL-field mapping using a name-similarity + value-
//      shape heuristic against the school's OWN field catalog (so it adapts to
//      whatever fields that school actually has), and
//   3. builds a dry-run plan so the operator sees exactly what an apply would do
//      BEFORE any GHL write.
//
// Everything here is PURE + deterministic (no I/O, no Date/Math.random) so it's
// fully unit-testable. The route supplies the target list (core contact fields
// + school_field_catalog rows) and, optionally, an AI refinement pass on top.

// ─── Types ───────────────────────────────────────────────────────────────

export interface ParsedCsv {
  columns: string[];
  rows: Array<Record<string, string>>;
}

export type ValueShape = 'email' | 'phone' | 'date' | 'number' | 'text';

// A place a CSV column can map to. `core` = a native GHL contact field
// (firstName/lastName/email/phone); `custom` = a GHL custom field written by id.
export interface TargetField {
  key: string;                 // 'first_name' | 'email' | field_key of a custom field
  label: string;               // human label
  kind: 'core' | 'custom';
  type: ValueShape;            // expected value shape (drives matching + validation)
  ghl_field_id?: string | null; // for custom fields (write target)
}

export interface MappingRow {
  csv_column: string;
  target_key: string | null;   // null = unmapped / skip
  target_label: string | null;
  target_kind: 'core' | 'custom' | null;
  target_type: ValueShape | null;
  ghl_field_id: string | null;
  confidence: number;          // 0..1
  method: 'heuristic' | 'ai' | 'manual' | 'none';
  skip: boolean;
}

export interface MigrationPlan {
  total_rows: number;
  importable_rows: number;     // rows with at least a name or an email
  skipped_rows: number;        // rows with neither (can't create a contact)
  mapped_columns: number;
  unmapped_columns: string[];
  field_fill: Array<{ target_label: string; target_key: string; filled: number }>;
  sample_contacts: Array<{ firstName: string; lastName: string; email: string; fields: number }>;
  warnings: string[];
}

// The four native GHL contact fields, always available as targets.
// Contacts in this domain ARE the parents/guardians, so the labels carry
// "parent" terminology — that's what makes "Parent First" / "Mother Email"
// columns land here instead of on the student slots.
export const CORE_TARGETS: TargetField[] = [
  { key: 'first_name', label: 'Parent / contact first name', kind: 'core', type: 'text' },
  { key: 'last_name', label: 'Parent / contact last name', kind: 'core', type: 'text' },
  { key: 'email', label: 'Parent / contact email', kind: 'core', type: 'email' },
  { key: 'phone', label: 'Parent / contact phone', kind: 'core', type: 'phone' },
];

// GHL custom-field dataType → our value shape.
export function shapeFromDataType(dt: string | null | undefined): ValueShape {
  const t = (dt || '').toUpperCase();
  if (t.includes('EMAIL')) return 'email';
  if (t.includes('PHONE')) return 'phone';
  if (t.includes('DATE')) return 'date';
  if (t.includes('NUMER') || t.includes('MONET')) return 'number';
  return 'text';
}

// ─── CSV parsing ─────────────────────────────────────────────────────────

// Parse CSV text into { columns, rows }. Handles quoted fields, escaped quotes
// (""), commas + newlines inside quotes, and CRLF/CR/LF line endings. Extra
// cells beyond the header are dropped; missing cells become ''. `maxRows` caps
// the number of DATA rows kept (0 = unlimited).
export function parseCsv(text: string, maxRows = 0): ParsedCsv {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // any char seen on the current record?

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(record); record = []; started = false; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      started = true;
      continue;
    }
    if (c === '"') { inQuotes = true; started = true; continue; }
    if (c === ',') { pushField(); started = true; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i++; pushRecord(); continue; }
    if (c === '\n') { pushRecord(); continue; }
    field += c;
    started = true;
  }
  // Flush trailing field/record if the file didn't end with a newline.
  if (started || field !== '' || record.length > 0) pushRecord();

  // Drop fully-empty trailing records (blank lines).
  while (records.length && records[records.length - 1].every((c) => c === '')) records.pop();
  if (records.length === 0) return { columns: [], rows: [] };

  const rawHeader = records[0];
  // De-duplicate blank / repeated headers so row objects don't collide.
  const seen = new Map<string, number>();
  const columns = rawHeader.map((h, idx) => {
    let name = (h ?? '').trim() || `Column ${idx + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    return name;
  });

  const dataRecords = maxRows > 0 ? records.slice(1, 1 + maxRows) : records.slice(1);
  const rows = dataRecords.map((rec) => {
    const obj: Record<string, string> = {};
    columns.forEach((col, idx) => { obj[col] = (rec[idx] ?? '').trim(); });
    return obj;
  });
  return { columns, rows };
}

// Up to `n` distinct non-empty sample values for a column.
export function columnSamples(rows: Array<Record<string, string>>, column: string, n = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const v = (r[column] ?? '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

// ─── Value-shape detection ───────────────────────────────────────────────

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})$/;

function looksPhone(v: string): boolean {
  const digits = v.replace(/[^\d]/g, '');
  return digits.length >= 7 && digits.length <= 15 && /^[\d\s()+.\-]+$/.test(v);
}
function looksNumber(v: string): boolean {
  return /^-?\$?\d[\d,]*(\.\d+)?$/.test(v.trim());
}

// Infer the dominant shape of a column's sample values.
export function detectShape(samples: string[]): ValueShape {
  if (samples.length === 0) return 'text';
  const frac = (pred: (v: string) => boolean) => samples.filter(pred).length / samples.length;
  // Date before phone: dashed dates (2020-01-02) otherwise read as phone-ish.
  if (frac((v) => EMAIL_RE.test(v)) >= 0.6) return 'email';
  if (frac((v) => DATE_RE.test(v)) >= 0.6) return 'date';
  if (frac(looksPhone) >= 0.6) return 'phone';
  if (frac(looksNumber) >= 0.6) return 'number';
  return 'text';
}

// ─── Name-similarity matching ────────────────────────────────────────────

// Tokenize a header/label: lowercase, split on non-alphanumerics, drop pure
// numbers (so "Student 1 First Name" ~ "Student First Name") and noise words.
const NOISE = new Set(['the', 'a', 'of', 'and', 'no', 'num', 'number', '#']);
const SYNONYMS: Record<string, string> = {
  mail: 'email', mobile: 'phone', cell: 'phone', tel: 'phone',
  telephone: 'phone', fname: 'first', lname: 'last', surname: 'last',
  given: 'first', dob: 'birth', birthdate: 'birth', birthday: 'birth',
  child: 'student', kid: 'student', pupil: 'student', guardian: 'parent',
  mother: 'parent', father: 'parent', mom: 'parent', dad: 'parent',
  grade: 'grade', gradelevel: 'grade', addr: 'address', zip: 'zip',
  zipcode: 'zip', postal: 'zip',
};
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of (s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (/^\d+$/.test(raw)) continue;       // drop slot numbers
    if (raw.length === 1) continue;        // drop stray initials / single letters
    if (NOISE.has(raw)) continue;
    out.push(SYNONYMS[raw] ?? raw);
  }
  return out;
}

// Token-set similarity (Jaccard) with a containment bonus so that
// "email" ⊂ "parent email" still scores well.
function nameScore(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const containment = inter / Math.min(a.size, b.size); // 1 if one ⊆ other
  return 0.65 * jaccard + 0.35 * containment;
}

// The slot number in a target label ("Student 2 …" → 2, "Parent 3 …" → 3),
// or 0 if unnumbered. Used to prefer the primary/native field for a column
// that carries no slot number of its own.
function slotOf(label: string): number {
  const m = /\b(\d+)\b/.exec(label || '');
  return m ? parseInt(m[1], 10) : 0;
}

// Score a column against a target: name similarity + a value-shape agreement
// nudge. Returns 0..~1.1 (shape agreement can push a clear email/phone over).
function scoreTarget(colRaw: string, colTokens: string[], colShape: ValueShape, target: TargetField): number {
  let s = nameScore(colTokens, tokenize(target.label));
  if (colShape !== 'text') {
    if (target.type === colShape) s += 0.25;           // shapes agree → boost
    else if (target.type !== 'text') s -= 0.15;        // shapes conflict → penalize
  }
  // Strong shape anchors: an email/phone-shaped column should land on the
  // matching core field even when the header is oddly named.
  if (colShape === 'email' && target.key === 'email') s += 0.2;
  if (colShape === 'phone' && target.key === 'phone') s += 0.2;
  // Slot preference: an UNNUMBERED column ("Parent Email") should prefer the
  // primary/native field over a slot-2+ custom field ("Parent 2 Email"). Only
  // penalize when the column itself carries no digit — "Parent 2 Email" (with
  // its own 2) still lands on the slot-2 field at full score.
  const slot = slotOf(target.label);
  if (slot >= 2 && !/\d/.test(colRaw)) s -= 0.2 * (slot - 1);
  return s;
}

const AUTO_THRESHOLD = 0.34;

// Propose a mapping for every column via all-pairs greedy assignment: score
// every (column, target) pair, then assign in descending-score order so each
// column and each target is used at most once. A column whose best target is
// claimed by a stronger column falls back to its next-best. Deterministic —
// ties resolve by column then target input order.
export function proposeMapping(
  columns: string[],
  samplesByColumn: Record<string, string[]>,
  targets: TargetField[],
): MappingRow[] {
  const pairs: Array<{ ci: number; ti: number; col: string; target: TargetField; score: number }> = [];
  columns.forEach((col, ci) => {
    const colTokens = tokenize(col);
    const colShape = detectShape(samplesByColumn[col] ?? []);
    targets.forEach((t, ti) => {
      const score = scoreTarget(col, colTokens, colShape, t);
      if (score >= AUTO_THRESHOLD) pairs.push({ ci, ti, col, target: t, score });
    });
  });
  // Highest score first; stable tie-break on column then target order.
  pairs.sort((a, b) => b.score - a.score || a.ci - b.ci || a.ti - b.ti);

  const claimedTarget = new Set<string>();
  const byCol = new Map<string, { target: TargetField; score: number }>();
  for (const p of pairs) {
    if (byCol.has(p.col)) continue;
    if (claimedTarget.has(p.target.key)) continue;
    claimedTarget.add(p.target.key);
    byCol.set(p.col, { target: p.target, score: p.score });
  }

  return columns.map((col) => {
    const hit = byCol.get(col);
    if (!hit) {
      return { csv_column: col, target_key: null, target_label: null, target_kind: null, target_type: null, ghl_field_id: null, confidence: 0, method: 'none', skip: true };
    }
    return {
      csv_column: col,
      target_key: hit.target.key,
      target_label: hit.target.label,
      target_kind: hit.target.kind,
      target_type: hit.target.type,
      ghl_field_id: hit.target.ghl_field_id ?? null,
      confidence: Math.min(1, Math.round(hit.score * 100) / 100),
      method: 'heuristic',
      skip: false,
    };
  });
}

// ─── Dry-run plan ────────────────────────────────────────────────────────

// Build a safe preview of what an apply would do — computed purely from the
// stored rows + mapping, no GHL calls. A row is importable if it resolves at
// least a name or an email (enough to create/match a contact).
export function buildPlan(rows: Array<Record<string, string>>, mapping: MappingRow[]): MigrationPlan {
  const active = mapping.filter((m) => m.target_key && !m.skip);
  const colFor = (key: string) => active.find((m) => m.target_key === key)?.csv_column ?? null;
  const firstCol = colFor('first_name');
  const lastCol = colFor('last_name');
  const emailCol = colFor('email');

  const fill = new Map<string, { label: string; filled: number }>();
  for (const m of active) fill.set(m.target_key as string, { label: m.target_label as string, filled: 0 });

  let importable = 0, skipped = 0;
  const samples: MigrationPlan['sample_contacts'] = [];
  for (const r of rows) {
    let fieldCount = 0;
    for (const m of active) {
      const v = (r[m.csv_column] ?? '').trim();
      if (v) { fieldCount++; const f = fill.get(m.target_key as string); if (f) f.filled++; }
    }
    const firstName = firstCol ? (r[firstCol] ?? '').trim() : '';
    const lastName = lastCol ? (r[lastCol] ?? '').trim() : '';
    const email = emailCol ? (r[emailCol] ?? '').trim() : '';
    if (firstName || lastName || email) {
      importable++;
      if (samples.length < 5) samples.push({ firstName, lastName, email, fields: fieldCount });
    } else {
      skipped++;
    }
  }

  const warnings: string[] = [];
  if (!emailCol) warnings.push('No column is mapped to Contact email — rows will be created without a way to dedupe against existing GHL contacts.');
  if (!firstCol && !lastCol) warnings.push('No column is mapped to a contact name.');

  return {
    total_rows: rows.length,
    importable_rows: importable,
    skipped_rows: skipped,
    mapped_columns: active.length,
    unmapped_columns: mapping.filter((m) => !m.target_key || m.skip).map((m) => m.csv_column),
    field_fill: [...fill.entries()].map(([key, v]) => ({ target_key: key, target_label: v.label, filled: v.filled })),
    sample_contacts: samples,
    warnings,
  };
}

// A contact ready to upsert into GHL, resolved from one CSV row.
export interface ContactPayload {
  rowIndex: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  customFields: Array<{ id: string; value: string }>;
}

// Turn stored rows + an active mapping into GHL-ready contact payloads (PURE —
// no GHL calls). Rows with neither a name nor an email are dropped (can't make
// a contact). Custom targets need a ghl_field_id to be writable; those without
// one are skipped (and surfaced via `missingFieldIds`).
export function resolveContactPayloads(
  rows: Array<Record<string, string>>,
  mapping: MappingRow[],
): { payloads: ContactPayload[]; missingFieldIds: string[] } {
  const active = mapping.filter((m) => m.target_key && !m.skip);
  const core = (key: string) => active.find((m) => m.target_key === key)?.csv_column ?? null;
  const firstCol = core('first_name'), lastCol = core('last_name'), emailCol = core('email'), phoneCol = core('phone');
  const customCols = active.filter((m) => m.target_kind === 'custom');
  const missingFieldIds = [...new Set(customCols.filter((m) => !m.ghl_field_id).map((m) => m.target_label as string))];

  const payloads: ContactPayload[] = [];
  rows.forEach((r, rowIndex) => {
    const firstName = firstCol ? (r[firstCol] ?? '').trim() : '';
    const lastName = lastCol ? (r[lastCol] ?? '').trim() : '';
    const email = emailCol ? (r[emailCol] ?? '').trim() : '';
    const phone = phoneCol ? (r[phoneCol] ?? '').trim() : '';
    if (!firstName && !lastName && !email) return; // unimportable
    const customFields: ContactPayload['customFields'] = [];
    for (const m of customCols) {
      if (!m.ghl_field_id) continue;
      const v = (r[m.csv_column] ?? '').trim();
      if (v) customFields.push({ id: m.ghl_field_id, value: v });
    }
    payloads.push({ rowIndex, firstName, lastName, email, phone, customFields });
  });
  return { payloads, missingFieldIds };
}

// Merge operator overrides (from the review UI) onto a mapping, re-resolving
// target metadata from the target list so a hand-picked key carries its label /
// type / ghl id. `overrides` maps csv_column → target_key ('' / '__skip__' to
// unmap). Marks touched rows as method:'manual'.
export function applyOverrides(
  mapping: MappingRow[],
  overrides: Record<string, string>,
  targets: TargetField[],
): MappingRow[] {
  const byKey = new Map(targets.map((t) => [t.key, t]));
  return mapping.map((m) => {
    if (!(m.csv_column in overrides)) return m;
    const chosen = overrides[m.csv_column];
    if (!chosen || chosen === '__skip__') {
      return { ...m, target_key: null, target_label: null, target_kind: null, target_type: null, ghl_field_id: null, confidence: 0, method: 'manual', skip: true };
    }
    const t = byKey.get(chosen);
    if (!t) return m;
    return {
      ...m, target_key: t.key, target_label: t.label, target_kind: t.kind,
      target_type: t.type, ghl_field_id: t.ghl_field_id ?? null, confidence: 1, method: 'manual', skip: false,
    };
  });
}
