// Canonical parent-portal origin per school — every parent-facing link
// (form invites, welcome emails, shareable links) must use the school's
// own domain (school_branding.custom_host, e.g.
// portal.desertgardenmontessori.org). Links to the shared *.vercel.app
// host trip security filters on some parents' machines. Falls back to
// the shared host for schools without a custom domain.

import { query } from '@/lib/db';

const SHARED_BASE = (process.env.PARENT_PORTAL_BASE_URL
  ?? 'https://growth-suite-parent-portal.vercel.app').replace(/\/$/, '');

export async function parentPortalBaseForSchool(schoolId: string): Promise<string> {
  try {
    const { rows } = await query<{ custom_host: string | null }>(
      `SELECT custom_host FROM school_branding WHERE school_id = $1`,
      [schoolId],
    );
    const host = rows[0]?.custom_host?.trim().toLowerCase();
    if (host) return `https://${host}`;
  } catch { /* fall through */ }
  return SHARED_BASE;
}
