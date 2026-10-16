// Family structure + pickups as self-serve roster attributes.
//
// The expanded student row already shows parents, siblings and the
// authorized-pickup list — but only one family at a time. The office
// wants to scan (and export) them for the whole school, so they're
// offered as columns/filters in Customize like any other attribute:
//
//   family:guardians          every parent/guardian on the family who can
//                             see THIS student (per-parent scoping honored)
//   family:siblings           the student's active siblings at the school
//   family:authorized_pickups the family's active pickup people
//
// Values are synthesized at read time from our own tables (parents,
// students, pickup_persons) — not stored in school_filter_catalog, which
// the GHL attribute sync rebuilds from scratch.

import { query } from '@/lib/db';

export const FAMILY_ATTR_PREFIX = 'family:';
const NL = String.fromCharCode(10); // one entry per line — roster cells render pre-wrap

const DEFS = [
  { key: 'family:guardians', label: 'Parents / guardians (name, phone, email)' },
  { key: 'family:siblings', label: 'Siblings at school' },
  { key: 'family:authorized_pickups', label: 'Authorized pickups (name, relationship, phone)' },
] as const;

export interface FamilyAttr {
  attr_key: string;
  attr_type: 'family';
  label: string;
  data_type: string;
  value_count: number;
  sample_values: string[];
}

export async function listFamilyAttrs(schoolId: string): Promise<FamilyAttr[]> {
  const { rows } = await query<{ families: number; multi: number; pickup_fams: number }>(
    `SELECT (SELECT COUNT(DISTINCT family_id)::int FROM parents
              WHERE school_id = $1 AND status = 'active') AS families,
            (SELECT COUNT(*)::int FROM (
               SELECT family_id FROM students WHERE school_id = $1 AND status = 'active'
                GROUP BY family_id HAVING COUNT(*) > 1) m) AS multi,
            (SELECT COUNT(DISTINCT family_id)::int FROM pickup_persons
              WHERE school_id = $1 AND active = true) AS pickup_fams`,
    [schoolId],
  );
  const c = rows[0] ?? { families: 0, multi: 0, pickup_fams: 0 };
  const counts: Record<string, number> = {
    'family:guardians': c.families,
    'family:siblings': c.multi,
    'family:authorized_pickups': c.pickup_fams,
  };
  return DEFS.map((d) => ({
    attr_key: d.key, attr_type: 'family', label: d.label,
    data_type: 'text', value_count: counts[d.key] ?? 0, sample_values: [],
  }));
}

// US numbers as (330) 555-1234; anything else left as typed.
function fmtPhone(v: string | null): string {
  const raw = (v ?? '').trim();
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw;
}

const fullName = (first: string | null, last: string | null) =>
  [first, last].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');

// student id → { attr_key → display value } for the requested family attrs.
export async function resolveFamilyAttrValues(
  schoolId: string,
  attrKeys: string[],
): Promise<Map<string, Record<string, string>>> {
  const wanted = new Set(attrKeys.filter((a) => DEFS.some((d) => d.key === a)));
  const out = new Map<string, Record<string, string>>();
  if (wanted.size === 0) return out;

  const { rows: students } = await query<{ id: string; family_id: string; name: string; room: string | null; enrollment: string | null }>(
    `SELECT s.id, s.family_id,
            (SELECT e.status FROM enrollments e WHERE e.student_id = s.id
              ORDER BY e.created_at DESC LIMIT 1) AS enrollment,
            COALESCE(NULLIF(s.preferred_name, ''), s.first_name) || ' ' || s.last_name AS name,
            COALESCE(NULLIF(s.metadata->>'homeroom', ''), NULLIF(s.metadata->>'classroom_name', ''),
                     NULLIF(s.metadata->>'program', '')) AS room
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
      ORDER BY s.date_of_birth NULLS LAST, s.first_name`,
    [schoolId],
  );
  const byFamily = new Map<string, typeof students>();
  for (const s of students) {
    const list = byFamily.get(s.family_id) ?? [];
    list.push(s);
    byFamily.set(s.family_id, list);
  }

  // family id → parents (with their per-student scope; empty = all kids)
  const guardiansByFamily = new Map<string, Array<{ line: string; scope: Set<string> }>>();
  if (wanted.has('family:guardians')) {
    const { rows } = await query<{
      family_id: string; first_name: string | null; last_name: string | null;
      email: string | null; phone: string | null; is_primary: boolean; scope: string[];
    }>(
      `SELECT p.family_id, p.first_name, p.last_name, p.email, p.phone, p.is_primary,
              COALESCE((SELECT array_agg(psa.student_id::text) FROM parent_student_assignments psa
                         WHERE psa.parent_id = p.id), ARRAY[]::text[]) AS scope
         FROM parents p
        WHERE p.school_id = $1 AND p.status = 'active'
        ORDER BY p.is_primary DESC, p.first_name`,
      [schoolId],
    );
    for (const p of rows) {
      const name = fullName(p.first_name, p.last_name) || '(no name)';
      const bits = [p.is_primary ? `${name} (primary)` : name, fmtPhone(p.phone), p.email].filter((b) => b && String(b).trim());
      const list = guardiansByFamily.get(p.family_id) ?? [];
      list.push({ line: bits.join(' · '), scope: new Set(p.scope) });
      guardiansByFamily.set(p.family_id, list);
    }
  }

  // family id → pickup lines (deduped by name + phone; parents re-add people)
  const pickupsByFamily = new Map<string, string[]>();
  if (wanted.has('family:authorized_pickups')) {
    const { rows } = await query<{
      family_id: string; name: string; relationship: string | null; phone: string | null; is_temporary: boolean;
    }>(
      `SELECT family_id, name, relationship, phone, COALESCE(is_temporary, false) AS is_temporary
         FROM pickup_persons
        WHERE school_id = $1 AND active = true AND family_id IS NOT NULL
          AND NOT (COALESCE(is_temporary, false) AND pin_expires_at IS NOT NULL AND pin_expires_at < now())
        ORDER BY name`,
      [schoolId],
    );
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.family_id}|${r.name.trim().toLowerCase()}|${(r.phone ?? '').replace(/\D/g, '')}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const rel = (r.relationship ?? '').trim();
      const line = `${r.name.trim()}${rel ? ` (${rel})` : ''}${r.phone ? ` ${fmtPhone(r.phone)}` : ''}${r.is_temporary ? ' — temporary' : ''}`;
      const list = pickupsByFamily.get(r.family_id) ?? [];
      list.push(line);
      pickupsByFamily.set(r.family_id, list);
    }
  }

  for (const s of students) {
    const vals: Record<string, string> = {};
    if (wanted.has('family:guardians')) {
      const v = (guardiansByFamily.get(s.family_id) ?? [])
        .filter((g) => g.scope.size === 0 || g.scope.has(s.id))
        .map((g) => g.line).join(NL);
      if (v) vals['family:guardians'] = v;
    }
    if (wanted.has('family:siblings')) {
      const v = (byFamily.get(s.family_id) ?? [])
        .filter((o) => o.id !== s.id)
        // a withdrawn / not-yet-enrolled sibling is still family, but say so
        .map((o) => `${o.room ? `${o.name} (${o.room})` : o.name}${o.enrollment && o.enrollment !== 'enrolled' ? ` — ${o.enrollment}` : !o.enrollment ? ' — not enrolled' : ''}`)
        .join(NL);
      if (v) vals['family:siblings'] = v;
    }
    if (wanted.has('family:authorized_pickups')) {
      const v = (pickupsByFamily.get(s.family_id) ?? []).join(NL);
      if (v) vals['family:authorized_pickups'] = v;
    }
    if (Object.keys(vals).length) out.set(s.id, vals);
  }
  return out;
}
