import { query } from '@/lib/db';
import type { SchoolDashboardRow } from './types';

export interface SchoolRecord {
  id: string;
  name: string;
  ghl_location_id: string;
  // Standalone schools gate /school pages behind the staff magic-link
  // session; legacy schools stay open-URL (false).
  require_staff_login: boolean;
}

export async function loadSchoolByLocationId(locationId: string): Promise<SchoolRecord | null> {
  const { rows } = await query<SchoolRecord>(
    `SELECT id, name, ghl_location_id, COALESCE(require_staff_login, false) AS require_staff_login
       FROM schools WHERE ghl_location_id = $1`,
    [locationId]
  );
  return rows[0] ?? null;
}

export async function listSchoolDashboards(
  schoolId: string,
  opts?: { onlyEnabled?: boolean }
): Promise<SchoolDashboardRow[]> {
  const wheres: string[] = ['school_id = $1'];
  const params: unknown[] = [schoolId];
  if (opts?.onlyEnabled) {
    wheres.push('is_enabled = true');
  }
  const { rows } = await query<SchoolDashboardRow>(
    `SELECT * FROM school_dashboards
       WHERE ${wheres.join(' AND ')}
       ORDER BY position, display_name`,
    params
  );
  return rows;
}

export async function getSchoolDashboard(
  schoolId: string,
  dashboardSlug: string
): Promise<SchoolDashboardRow | null> {
  const { rows } = await query<SchoolDashboardRow>(
    `SELECT * FROM school_dashboards
       WHERE school_id = $1 AND dashboard_slug = $2`,
    [schoolId, dashboardSlug]
  );
  return rows[0] ?? null;
}
