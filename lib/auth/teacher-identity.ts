// Per-teacher identity for staff-request submissions.
//
// Background:
//   The school session is location-scoped (per migration to proxy.ts
//   auto-mint), so it uses a placeholder user_email='embed@iframe' for
//   anyone clicking into the iframe via the GHL Custom Menu Link. That
//   gives us school-level access control but NOT per-teacher identity.
//
// Solution:
//   First time a teacher clicks "Submit a Request", they pick their
//   name from the DGM staff roster. We persist their email in a
//   30-day cookie (gsd_teacher_email). Every staff-request submission
//   reads the cookie and uses it as submitter_email so "My Requests"
//   filters per-teacher, and Lexi's inbox shows who actually submitted.
//
//   Future: when DGM wires GHL's Custom Menu Link to sign a JWT with
//   real user info (via /api/auth/ghl-exchange), the school session's
//   user_email will be the real teacher email and the cookie becomes
//   a no-op fallback. Until then the cookie is the authoritative
//   teacher identifier.

import { cookies } from 'next/headers';

export const TEACHER_EMAIL_COOKIE = 'gsd_teacher_email';
export const TEACHER_NAME_COOKIE  = 'gsd_teacher_name';

// 30-day TTL — long enough that a teacher on their own laptop doesn't
// have to re-identify every time, short enough that a stale cookie on
// a shared/lost device eventually expires.
export const TEACHER_COOKIE_TTL_S = 30 * 24 * 60 * 60;

// Loose RFC-ish email validator. We're not trying to be exhaustive —
// just blocking obvious garbage so we don't write nonsense into the
// submitter_email column.
export function isValidEmail(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// Returns the teacher's identified email if the cookie is set, else
// null. Server components and route handlers both call this.
export async function getTeacherIdentity(): Promise<{ email: string; name: string | null } | null> {
  const ck = await cookies();
  const email = (ck.get(TEACHER_EMAIL_COOKIE)?.value ?? '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) return null;
  const name = (ck.get(TEACHER_NAME_COOKIE)?.value ?? '').trim() || null;
  return { email, name };
}

// The staff roster itself now lives in the school_staff_directory
// table (migration 103), maintained by the office at
// /school/[locationId]/staff-directory. Load it with
// getStaffDirectory() from lib/auth/staff-directory (server-only).
