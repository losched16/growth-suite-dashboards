// DB-backed staff directory (migration 103). Replaces the hardcoded
// DGM_STAFF_DIRECTORY array so the office can maintain the roster
// themselves via /school/[locationId]/staff-directory.
//
// Server-only module (pulls in pg via @/lib/db) — keep it out of
// client components; they receive the list as a prop.

import { query } from '@/lib/db';

export interface StaffDirectoryEntry {
  email: string;
  name: string;
}

export async function getStaffDirectory(schoolId: string): Promise<StaffDirectoryEntry[]> {
  const { rows } = await query<StaffDirectoryEntry>(
    `SELECT lower(email) AS email, name
       FROM school_staff_directory
      WHERE school_id = $1
      ORDER BY name`,
    [schoolId],
  );
  return rows;
}
