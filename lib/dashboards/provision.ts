import { query } from '@/lib/db';
import { dashboardRegistry } from './registry';

// Idempotent: skips dashboards that already exist for the school.
// Returns counts: how many were created, how many already existed.
export async function provisionDefaults(schoolId: string): Promise<{
  created: string[];
  skipped: string[];
}> {
  const created: string[] = [];
  const skipped: string[] = [];

  let position = 0;
  for (const def of Object.values(dashboardRegistry)) {
    const { rowCount } = await query(
      `INSERT INTO school_dashboards
         (school_id, dashboard_slug, display_name, description, layout, is_enabled, position)
       VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
       ON CONFLICT (school_id, dashboard_slug) DO NOTHING`,
      [
        schoolId,
        def.slug,
        def.display_name,
        def.description,
        JSON.stringify(def.default_layout),
        position,
      ]
    );
    if (rowCount && rowCount > 0) created.push(def.slug);
    else skipped.push(def.slug);
    position++;
  }

  return { created, skipped };
}
