// Self-adapting data layer, Phase 1 — field & tag discovery.
//
// refreshFieldCatalog() runs on each sync: it enumerates the location's GHL
// custom fields (with type + options) and the tags in use, and diffs them into
// school_field_catalog / school_tag_catalog. New fields/tags/options are
// auto-discovered so they can be surfaced as dashboard columns / filters /
// form conditions later (Phase 2) — additions are always safe.
//
// GHL stays the source of truth; this is our read model of its field/tag
// surface. Reads GHL + writes only our own tables — no destructive external
// writes.

import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { buildFieldKit, RESERVED_TAGS } from '@/lib/onboarding/field-kit';

// GHL derives fieldKey from a field's name ("Student 1 Grade Level" →
// contact.student_1_grade_level). Mirror that to match discovered fields to
// the field-kit's core set.
function keyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
const normKey = (raw: string) => raw.replace(/^contact\./, '');

// The ~150 field-kit field keys — the "core" everything already depends on.
let CORE_KEYS: Set<string> | null = null;
function coreKeys(): Set<string> {
  if (!CORE_KEYS) CORE_KEYS = new Set(buildFieldKit().map((f) => keyFromName(f.name)));
  return CORE_KEYS;
}

interface GhlCustomField {
  id?: string;
  name?: string;
  fieldKey?: string;
  key?: string;
  dataType?: string;
  picklistOptions?: unknown;
}

function optionLabels(f: GhlCustomField): string[] {
  if (!Array.isArray(f.picklistOptions)) return [];
  return f.picklistOptions
    .map((o) => (typeof o === 'string' ? o : String((o as { name?: string })?.name ?? '')))
    .filter(Boolean);
}

export interface CatalogDiff {
  newFields: Array<{ field_key: string; label: string | null; data_type: string | null }>;
  newOptions: Array<{ field_key: string; options: string[] }>;
  missingFields: string[];   // fields that were in the catalog but not on GHL now
  newTags: string[];
  totalFields: number;
  totalTags: number;
}

// Discover + persist. Best-effort by design — the caller (sync) wraps it so a
// failure here never fails the sync.
export async function refreshFieldCatalog(schoolId: string): Promise<CatalogDiff> {
  const diff: CatalogDiff = {
    newFields: [], newOptions: [], missingFields: [], newTags: [], totalFields: 0, totalTags: 0,
  };

  // ── Fields ────────────────────────────────────────────────────────────
  const client = await loadGhlClient(schoolId);
  const { data } = await client.axios.get<{ customFields?: GhlCustomField[] }>(
    `/locations/${client.locationId}/customFields`);
  const ghlFields = (data.customFields ?? []).filter((f) => (f.fieldKey ?? f.key));

  // Existing catalog for diffing (previous options + which keys we knew).
  const { rows: existingRows } = await query<{ field_key: string; options: string[]; missing_since: string | null }>(
    `SELECT field_key, options, missing_since FROM school_field_catalog WHERE school_id = $1`,
    [schoolId]);
  const existing = new Map(existingRows.map((r) => [r.field_key, r]));
  const core = coreKeys();
  const seenKeys = new Set<string>();

  for (const f of ghlFields) {
    const key = normKey(String(f.fieldKey ?? f.key ?? ''));
    if (!key) continue;
    seenKeys.add(key);
    const label = f.name ?? null;
    const dataType = f.dataType ?? null;
    const opts = optionLabels(f);
    const prev = existing.get(key);

    if (!prev) {
      diff.newFields.push({ field_key: key, label, data_type: dataType });
    } else {
      // Absorb any new picklist options (GHL-authoritative vocabulary).
      const prevOpts = new Set(prev.options ?? []);
      const added = opts.filter((o) => !prevOpts.has(o));
      if (added.length > 0) diff.newOptions.push({ field_key: key, options: added });
    }

    await query(
      `INSERT INTO school_field_catalog
         (school_id, field_key, ghl_field_id, label, data_type, options, is_core, last_seen_at, missing_since, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), NULL, now())
       ON CONFLICT (school_id, field_key) DO UPDATE SET
         ghl_field_id = EXCLUDED.ghl_field_id,
         label = EXCLUDED.label,
         data_type = EXCLUDED.data_type,
         options = EXCLUDED.options,
         is_core = EXCLUDED.is_core,
         last_seen_at = now(),
         missing_since = NULL,
         updated_at = now()`,
      [schoolId, key, f.id ?? null, label, dataType, JSON.stringify(opts), core.has(key)],
    );
  }

  // Fields that were catalogued but are gone now → flag missing (a possible
  // core-edit break to alert on). Never delete — keep for audit.
  for (const [key, prev] of existing) {
    if (!seenKeys.has(key) && !prev.missing_since) {
      diff.missingFields.push(key);
      await query(
        `UPDATE school_field_catalog SET missing_since = now(), updated_at = now()
          WHERE school_id = $1 AND field_key = $2`,
        [schoolId, key]);
    }
  }
  diff.totalFields = seenKeys.size;

  // ── Tags (from tags in use on synced contacts) ──────────────────────────
  const { rows: tagRows } = await query<{ tag: string; n: number }>(
    `SELECT lower(btrim(tag)) AS tag, COUNT(DISTINCT ghl_contact_id)::int AS n
       FROM ghl_contact_tags
      WHERE school_id = $1 AND btrim(coalesce(tag, '')) <> ''
      GROUP BY 1`,
    [schoolId]);
  const { rows: knownTagRows } = await query<{ tag: string }>(
    `SELECT tag FROM school_tag_catalog WHERE school_id = $1`, [schoolId]);
  const knownTags = new Set(knownTagRows.map((r) => r.tag));
  const reserved = new Set(RESERVED_TAGS.map((t) => t.toLowerCase()));

  for (const r of tagRows) {
    if (!knownTags.has(r.tag)) diff.newTags.push(r.tag);
    await query(
      `INSERT INTO school_tag_catalog (school_id, tag, is_reserved, contact_count, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (school_id, tag) DO UPDATE SET
         contact_count = EXCLUDED.contact_count,
         is_reserved = EXCLUDED.is_reserved,
         last_seen_at = now()`,
      [schoolId, r.tag, reserved.has(r.tag), r.n]);
  }
  diff.totalTags = tagRows.length;

  return diff;
}

// ── Read helpers (Phase 2 dashboards/forms read these) ─────────────────────

export interface CatalogField {
  field_key: string;
  label: string | null;
  data_type: string | null;
  options: string[];
  is_core: boolean;
  surfaced: boolean;
  first_seen_at: string;
  missing_since: string | null;
}

export interface CatalogTag {
  tag: string;
  is_reserved: boolean;
  surfaced: boolean;
  contact_count: number;
  first_seen_at: string;
}

export async function loadFieldCatalog(schoolId: string): Promise<{ fields: CatalogField[]; tags: CatalogTag[] }> {
  const { rows: fields } = await query<CatalogField>(
    `SELECT field_key, label, data_type, options, is_core, surfaced, first_seen_at, missing_since
       FROM school_field_catalog WHERE school_id = $1 ORDER BY is_core DESC, label NULLS LAST, field_key`,
    [schoolId]);
  const { rows: tags } = await query<CatalogTag>(
    `SELECT tag, is_reserved, surfaced, contact_count, first_seen_at
       FROM school_tag_catalog WHERE school_id = $1 ORDER BY contact_count DESC, tag`,
    [schoolId]);
  return { fields, tags };
}

// New items available since the school last reviewed — drives the "N new items
// found — add to a dashboard?" surfacing prompt (Phase 2). "New" = not yet
// surfaced and (for fields) not core.
export async function countUnsurfaced(schoolId: string): Promise<{ fields: number; tags: number }> {
  const { rows } = await query<{ f: number; t: number }>(
    `SELECT
       (SELECT COUNT(*) FROM school_field_catalog
         WHERE school_id = $1 AND surfaced = false AND is_core = false AND missing_since IS NULL)::int AS f,
       (SELECT COUNT(*) FROM school_tag_catalog
         WHERE school_id = $1 AND surfaced = false AND is_reserved = false)::int AS t`,
    [schoolId]);
  return { fields: rows[0]?.f ?? 0, tags: rows[0]?.t ?? 0 };
}
