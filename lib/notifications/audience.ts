// Audience resolution for in-portal notifications.
//
// An Audience is a combinable set of conditions (AND or OR). Each
// condition targets one dimension. A single condition = the quick
// picker; multiple = the power-filter builder. Resolution always
// restricts to ACTIVE parents of ENROLLED families — a portal
// notification can only land on someone who has a portal account.
//
// Used by:
//   - the live "reaches N parents" count (countAudience)
//   - the send action (resolveRecipients → delivery rows)

import { query } from '@/lib/db';

export type AudienceField =
  | 'all' | 'program' | 'homeroom' | 'grade_level' | 'tag' | 'family' | 'parent';

export interface AudienceCondition {
  field: AudienceField;
  values?: string[];
}

export interface Audience {
  match?: 'all' | 'any';   // default 'all' (AND)
  conditions: AudienceCondition[];
}

const METADATA_FIELD: Partial<Record<AudienceField, string>> = {
  program: 'program',
  homeroom: 'homeroom',
  grade_level: 'grade_level',
};

// Build the parent-selecting SQL for an audience. Returns the query text
// plus its params. $1 is always school_id. The SELECT yields one row per
// matching active parent.
export function audienceQuery(schoolId: string, audience: Audience): { sql: string; params: unknown[] } {
  const params: unknown[] = [schoolId];
  const conditions = Array.isArray(audience?.conditions) ? audience.conditions : [];

  const predicates: string[] = [];
  for (const c of conditions) {
    if (!c || typeof c.field !== 'string') continue;

    if (c.field === 'all') {
      predicates.push('TRUE');
      continue;
    }

    const vals = Array.isArray(c.values) ? c.values.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
    if (vals.length === 0) {
      // An incomplete condition matches no one — never silently broaden.
      predicates.push('FALSE');
      continue;
    }

    const mdField = METADATA_FIELD[c.field];
    if (mdField) {
      params.push(vals);
      predicates.push(
        `EXISTS (SELECT 1 FROM students s
                  WHERE s.family_id = f.id AND s.status = 'active'
                    AND s.metadata->>'${mdField}' = ANY($${params.length}::text[]))`,
      );
    } else if (c.field === 'tag') {
      params.push(vals.map((v) => v.toLowerCase()));
      predicates.push(
        `EXISTS (SELECT 1 FROM ghl_contact_tags t
                  WHERE t.ghl_contact_id = p.ghl_contact_id AND t.school_id = $1
                    AND lower(t.tag) = ANY($${params.length}::text[]))`,
      );
    } else if (c.field === 'family') {
      params.push(vals);
      predicates.push(`f.id = ANY($${params.length}::uuid[])`);
    } else if (c.field === 'parent') {
      params.push(vals);
      predicates.push(`p.id = ANY($${params.length}::uuid[])`);
    }
  }

  // No usable conditions → no recipients (safety: never accidental send-all).
  const combined = predicates.length === 0
    ? 'FALSE'
    : predicates.map((p) => `(${p})`).join(audience?.match === 'any' ? ' OR ' : ' AND ');

  const sql = `
    SELECT p.id AS parent_id, p.family_id
      FROM parents p
      JOIN families f ON f.id = p.family_id
     WHERE p.school_id = $1
       AND p.status = 'active'
       AND EXISTS (SELECT 1 FROM students s
                    WHERE s.family_id = f.id AND s.status = 'active')
       AND (${combined})`;

  return { sql, params };
}

export async function countAudience(schoolId: string, audience: Audience): Promise<number> {
  const { sql, params } = audienceQuery(schoolId, audience);
  const { rows } = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM (${sql}) q`, params);
  return Number(rows[0]?.n ?? 0);
}

export async function resolveRecipients(
  schoolId: string,
  audience: Audience,
): Promise<Array<{ parent_id: string; family_id: string | null }>> {
  const { sql, params } = audienceQuery(schoolId, audience);
  const { rows } = await query<{ parent_id: string; family_id: string | null }>(sql, params);
  return rows;
}

// ── Picker options: the distinct dimension values for THIS school ──────

export interface AudienceOptions {
  programs: string[];
  homerooms: string[];
  grades: string[];
  tags: string[];
  families: Array<{ id: string; label: string }>;
}

export async function loadAudienceOptions(schoolId: string): Promise<AudienceOptions> {
  const distinctMeta = async (key: string): Promise<string[]> => {
    const { rows } = await query<{ v: string }>(
      `SELECT DISTINCT s.metadata->>$2 AS v
         FROM students s
        WHERE s.school_id = $1
          AND s.status = 'active'
          AND btrim(coalesce(s.metadata->>$2, '')) <> ''
          AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'
        ORDER BY 1`,
      [schoolId, key],
    );
    return rows.map((r) => r.v);
  };

  const [programs, homerooms, grades] = await Promise.all([
    distinctMeta('program'),
    distinctMeta('homeroom'),
    distinctMeta('grade_level'),
  ]);

  // Only tags that actually sit on a parent contact (so targeting is
  // meaningful) — excludes donor-only contact tags that no parent carries.
  const { rows: tagRows } = await query<{ tag: string }>(
    `SELECT DISTINCT t.tag
       FROM ghl_contact_tags t
       JOIN parents p ON p.ghl_contact_id = t.ghl_contact_id
                     AND p.school_id = t.school_id AND p.status = 'active'
      WHERE t.school_id = $1 AND btrim(coalesce(t.tag, '')) <> ''
      ORDER BY 1`,
    [schoolId],
  );

  // Enrolled families, for the "specific family" search.
  const { rows: famRows } = await query<{ id: string; label: string }>(
    `SELECT f.id,
            COALESCE(NULLIF(f.display_name, ''), 'Family ' || left(f.id::text, 8)) AS label
       FROM families f
      WHERE f.school_id = $1
        AND EXISTS (SELECT 1 FROM students s WHERE s.family_id = f.id AND s.status = 'active')
      ORDER BY 2`,
    [schoolId],
  );

  return {
    programs,
    homerooms,
    grades,
    tags: tagRows.map((r) => r.tag),
    families: famRows,
  };
}

// Human-readable one-line summary of an audience, for the Sent list.
export function summarizeAudience(audience: Audience): string {
  const conditions = Array.isArray(audience?.conditions) ? audience.conditions : [];
  if (conditions.length === 0) return 'No one';
  if (conditions.some((c) => c.field === 'all')) return 'Everyone (all enrolled families)';
  const labelFor = (c: AudienceCondition): string => {
    const n = (c.values ?? []).length;
    switch (c.field) {
      case 'program': return `Program: ${(c.values ?? []).join(', ')}`;
      case 'homeroom': return `Classroom: ${(c.values ?? []).join(', ')}`;
      case 'grade_level': return `Grade: ${(c.values ?? []).join(', ')}`;
      case 'tag': return `Tag: ${(c.values ?? []).join(', ')}`;
      case 'family': return `${n} specific famil${n === 1 ? 'y' : 'ies'}`;
      case 'parent': return `${n} specific parent${n === 1 ? '' : 's'}`;
      default: return c.field;
    }
  };
  const joiner = audience?.match === 'any' ? ' OR ' : ' AND ';
  return conditions.map(labelFor).join(joiner);
}

// Validate/normalize an inbound audience from the compose UI.
export function sanitizeAudience(raw: unknown): Audience | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const match = r.match === 'any' ? 'any' : 'all';
  const condsIn = Array.isArray(r.conditions) ? r.conditions : [];
  const allowed: AudienceField[] = ['all', 'program', 'homeroom', 'grade_level', 'tag', 'family', 'parent'];
  const conditions: AudienceCondition[] = [];
  for (const c of condsIn) {
    if (!c || typeof c !== 'object') continue;
    const field = (c as Record<string, unknown>).field;
    if (typeof field !== 'string' || !allowed.includes(field as AudienceField)) continue;
    if (field === 'all') { conditions.push({ field: 'all' }); continue; }
    const valsRaw = (c as Record<string, unknown>).values;
    const values = Array.isArray(valsRaw)
      ? valsRaw.map((v) => String(v ?? '').trim()).filter(Boolean)
      : [];
    if (values.length === 0) continue;
    conditions.push({ field: field as AudienceField, values });
  }
  if (conditions.length === 0) return null;
  return { match, conditions };
}
