// Office-defined attendance status categories, stored per school in
// schools.settings.attendance_custom_statuses as [{key,label,color}].
// Self-serve managed from the Attendance dashboard; assignments live on
// daily_attendance.custom_status (migration 091).

import { query } from '@/lib/db';

export interface CustomAttendanceStatus {
  key: string;    // slug, stable identity ('field_trip')
  label: string;  // display text ('Field Trip')
  color: string;  // one of STATUS_COLORS keys
}

// Fixed palette — literal Tailwind classes (JIT-safe) keyed by a stored
// color name. Add here + in the dashboard picker to extend.
export const STATUS_COLORS = ['slate', 'amber', 'violet', 'sky', 'teal', 'rose', 'orange', 'lime'] as const;

export const MAX_CUSTOM_STATUSES = 12;

export function slugifyStatusKey(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
}

export function sanitizeCustomStatuses(raw: unknown): CustomAttendanceStatus[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomAttendanceStatus[] = [];
  for (const item of raw) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const color = typeof r.color === 'string' && (STATUS_COLORS as readonly string[]).includes(r.color)
      ? r.color : 'slate';
    if (!key || !label) continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, label: label.slice(0, 24), color });
    if (out.length >= MAX_CUSTOM_STATUSES) break;
  }
  return out;
}

export async function readCustomStatuses(schoolId: string): Promise<CustomAttendanceStatus[]> {
  const { rows } = await query<{ list: unknown }>(
    `SELECT settings->'attendance_custom_statuses' AS list FROM schools WHERE id = $1`,
    [schoolId],
  );
  return sanitizeCustomStatuses(rows[0]?.list);
}

export async function writeCustomStatuses(schoolId: string, list: CustomAttendanceStatus[]): Promise<void> {
  await query(
    `UPDATE schools
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{attendance_custom_statuses}', $2::jsonb)
      WHERE id = $1`,
    [schoolId, JSON.stringify(list)],
  );
}
