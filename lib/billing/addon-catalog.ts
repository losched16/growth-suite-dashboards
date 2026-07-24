// School-level tuition add-on catalog — the reusable "rate card" the
// enrollment builder pulls from so operators SELECT extended care / deposit /
// development fee instead of typing amounts per family.
//
// Stored in schools.settings.addon_catalog (JSONB, merged — never clobbers
// other settings keys). Read with loadAddonCatalog(); written with the
// self-serve editor + the seed script via a `settings || jsonb_build_object`
// merge.
//
// Each option carries a STABLE `id` (submitted by the form; the amount is
// re-resolved server-side so a tampered POST can't set an arbitrary price)
// and maps to a CANONICAL addon key ('extended_care' | 'deposit' |
// 'development_fee') so the stored plan addons match what recompute-plan.ts
// and the edit-fees editor already understand (discount basis, carry-over).

import { query } from '@/lib/db';

export type AddonCategory = 'extended_care' | 'deposit' | 'development_fee';

export interface AddonOption {
  id: string;            // stable, unique within its category
  label: string;         // shown in the picker + stored as the addon label
  amount_cents: number;  // positive = charge, negative = credit (deposit)
}

export interface AddonCatalog {
  extended_care: AddonOption[];
  deposit: AddonOption[];
  development_fee: AddonOption[];
}

// The canonical addon key each category maps to on the enrollment. Kept in
// lockstep with recompute-plan.ts (carry_over_keys / extended_care_keys) and
// the edit-fees editor's CREDIT_KEYS.
export const CATEGORY_KEY: Record<AddonCategory, string> = {
  extended_care: 'extended_care',
  deposit: 'deposit',
  development_fee: 'development_fee',
};

export const EMPTY_CATALOG: AddonCatalog = {
  extended_care: [],
  deposit: [],
  development_fee: [],
};

function normalizeOptions(raw: unknown): AddonOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AddonOption[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    const label = String(o.label ?? '').trim();
    const amount = Number(o.amount_cents);
    if (!id || !label || !Number.isFinite(amount) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, amount_cents: Math.round(amount) });
  }
  return out;
}

export function normalizeCatalog(raw: unknown): AddonCatalog {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    extended_care: normalizeOptions(r.extended_care),
    deposit: normalizeOptions(r.deposit),
    development_fee: normalizeOptions(r.development_fee),
  };
}

export async function loadAddonCatalog(schoolId: string): Promise<AddonCatalog> {
  const { rows } = await query<{ catalog: unknown }>(
    `SELECT settings->'addon_catalog' AS catalog FROM schools WHERE id = $1`,
    [schoolId],
  );
  return normalizeCatalog(rows[0]?.catalog);
}

export async function saveAddonCatalog(schoolId: string, catalog: AddonCatalog): Promise<void> {
  // JSONB merge so we only touch the addon_catalog key, never the rest of
  // schools.settings.
  await query(
    `UPDATE schools
        SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('addon_catalog', $2::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [schoolId, JSON.stringify(normalizeCatalog(catalog))],
  );
}

export interface ResolvedAddon { key: string; label: string; amount_cents: number }

// Turn a (category, option-id) selection into a canonical addon snapshot the
// generator + edit-fees editor understand. Returns null when the id isn't in
// the catalog (stale form / tampered POST) so the caller can ignore it.
export function resolveAddon(
  catalog: AddonCatalog,
  category: AddonCategory,
  optionId: string,
): ResolvedAddon | null {
  const opt = catalog[category].find((o) => o.id === optionId);
  if (!opt) return null;
  return { key: CATEGORY_KEY[category], label: opt.label, amount_cents: opt.amount_cents };
}

// ── MCH seed (Sept 2026 – Jun 2027 rate sheet) ───────────────────────────
// Extended care matrix: hours-past-the-school-day × days/week. Deposit +
// development fee as selectable options. Used by scripts/seed-mch-addons.
const EC = (id: string, hours: string, days: number, dollars: number): AddonOption => ({
  id,
  label: `Extended care (${hours}, ${days} days/week)`,
  amount_cents: dollars * 100,
});

export const MCH_ADDON_CATALOG_SEED: AddonCatalog = {
  extended_care: [
    EC('ec_le1_2d', '1 hour or less', 2, 975),
    EC('ec_le1_3d', '1 hour or less', 3, 1365),
    EC('ec_le1_4d', '1 hour or less', 4, 1720),
    EC('ec_le1_5d', '1 hour or less', 5, 2025),
    EC('ec_1to2_2d', '1–2 hours', 2, 1725),
    EC('ec_1to2_3d', '1–2 hours', 3, 2300),
    EC('ec_1to2_4d', '1–2 hours', 4, 2865),
    EC('ec_1to2_5d', '1–2 hours', 5, 3300),
    EC('ec_2to3_2d', '2–3 hours', 2, 2300),
    EC('ec_2to3_3d', '2–3 hours', 3, 3130),
    EC('ec_2to3_4d', '2–3 hours', 4, 3570),
    EC('ec_2to3_5d', '2–3 hours', 5, 4000),
    EC('ec_gt3_2d', 'more than 3 hours', 2, 2850),
    EC('ec_gt3_3d', 'more than 3 hours', 3, 3570),
    EC('ec_gt3_4d', 'more than 3 hours', 4, 4040),
    EC('ec_gt3_5d', 'more than 3 hours', 5, 4675),
  ],
  deposit: [
    { id: 'dep_child1', label: 'Deposit (paid) — Child 1', amount_cents: -40000 },
    { id: 'dep_sibling', label: 'Deposit (paid) — Sibling', amount_cents: -20000 },
  ],
  development_fee: [
    { id: 'dev_standard', label: 'Development fee', amount_cents: 20000 },
    { id: 'dev_kindergarten', label: 'Kindergarten development fee', amount_cents: 25000 },
  ],
};
