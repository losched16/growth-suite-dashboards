// Helpers for the per-school menu CMS.
//
// Slots are hardcoded for now (matching the three images on the
// existing menus page). If another school needs a different slot
// taxonomy later we can lift the list into school config — until
// then keeping it here keeps the editor UI simple.

import { query } from '@/lib/db';

export interface MenuSlot {
  key: string;        // stored in school_menu_assets.slot
  label: string;      // header on the menus page
  sub: string;        // small descriptive line
  fallbackPath: string; // /public file used until a DB upload exists
}

export const MENU_SLOTS: MenuSlot[] = [
  {
    key: 'lunch-calendar',
    label: 'Monthly Lunch Calendar',
    sub: 'What’s served each day this month',
    fallbackPath: '/dgm-menus/lunch-calendar.png',
  },
  {
    key: 'daily-snack-menu',
    label: 'Weekly Snack Menu',
    sub: 'Snacks for Infant and Toddler/Primary rooms',
    fallbackPath: '/dgm-menus/daily-snack-menu.png',
  },
  {
    key: 'harvest-of-the-month',
    label: 'Harvest of the Month',
    sub: 'The veggie / fruit / grain / bean / herb featured each month',
    fallbackPath: '/dgm-menus/harvest-of-the-month.png',
  },
];

export function isValidSlot(s: string): boolean {
  return MENU_SLOTS.some((slot) => slot.key === s);
}

// Returns the menu assets currently uploaded for the given school,
// keyed by slot. Slots without an upload yet are omitted — callers
// use the fallback PNG from /public.
export interface MenuAsset {
  id: string;
  uploaded_at: Date;
  uploaded_by: string | null;
  mime_type: string;
  display_label: string | null; // e.g. "October 2026", shown on the menus page
}

export async function getMenuAssetIndex(schoolId: string): Promise<Record<string, MenuAsset>> {
  const { rows } = await query<MenuAsset & { slot: string }>(
    `SELECT id, slot, uploaded_at, uploaded_by, mime_type, display_label
       FROM school_menu_assets
      WHERE school_id = $1`,
    [schoolId],
  );
  const out: Record<string, MenuAsset> = {};
  for (const r of rows) {
    out[r.slot] = {
      id: r.id, uploaded_at: r.uploaded_at, uploaded_by: r.uploaded_by,
      mime_type: r.mime_type, display_label: r.display_label,
    };
  }
  return out;
}

// What the file route will serve and the upload route will accept. Menus
// are images only (a PDF is turned into an image in the browser before it
// is uploaded) so a stored file can never be served as a script or page.
export const MENU_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface MenuEditor { id: string; email: string; name: string | null }

export async function getMenuEditors(schoolId: string): Promise<MenuEditor[]> {
  const { rows } = await query<MenuEditor>(
    `SELECT id, lower(email) AS email, name
       FROM school_menu_editors
      WHERE school_id = $1
      ORDER BY created_at`,
    [schoolId],
  );
  return rows;
}

// True iff `email` is on the menu editor allowlist for this school.
// Case-insensitive email match. Empty allowlist → nobody is an editor
// (operator hasn't seeded the list yet).
export async function isMenuEditor(schoolId: string, email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM school_menu_editors
         WHERE school_id = $1 AND lower(email) = lower($2)
     ) AS exists`,
    [schoolId, email.trim()],
  );
  return rows[0]?.exists === true;
}
