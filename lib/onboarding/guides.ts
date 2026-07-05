// Loads the task → help-content mapping (onboarding_guides). Content itself
// lives in Freshdesk / your KB — this is just the per-task link + optional
// video, so nothing is duplicated. Global (same for every school).

import { query } from '@/lib/db';

export interface TaskGuide {
  guide_url: string | null;
  guide_label: string | null;
  video_url: string | null;
}

export async function loadGuides(): Promise<Map<string, TaskGuide>> {
  const { rows } = await query<{ task_key: string } & TaskGuide>(
    `SELECT task_key, guide_url, guide_label, video_url FROM onboarding_guides`,
  );
  return new Map(rows.map((r) => [r.task_key, {
    guide_url: r.guide_url, guide_label: r.guide_label, video_url: r.video_url,
  }]));
}
