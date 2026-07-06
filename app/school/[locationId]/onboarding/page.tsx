// /school/[locationId]/onboarding — the self-resolving onboarding entry point.
//
// A single, static GHL custom-menu link per school ("Set Up Your School")
// points here with the school's embed_token, exactly like the dashboard
// embeds. It lives under the /school/[locationId] layout, so it inherits the
// same embed authentication — no per-onboarding token to juggle in the menu.
//
// It finds (or creates) this school's onboarding record, mints a fresh
// onboarding token for it, and hands off to the token-authed checklist
// (/onboarding/[token]) which renders the setup steps and handles the
// intake/upload/manual form actions. Because the menu link is stable, every
// visit re-resolves and re-mints — the token never goes stale for the school.

import { redirect, notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { mintOnboardingToken } from '@/lib/onboarding/token';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

export default async function SchoolOnboardingResolve({ params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Most recent non-archived onboarding for this school (by school_id or, for
  // records created before provisioning linked them, by location).
  const found = await query<{ id: string }>(
    `SELECT id FROM school_onboarding
      WHERE (school_id = $1 OR ghl_location_id = $2) AND archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [school.id, locationId],
  );

  let onboardingId = found.rows[0]?.id;

  // Provisioned school with no onboarding record yet → create one on the spot
  // so the school lands straight on their setup checklist (self-serve). The
  // school already has a session for this location, so this is legitimate.
  if (!onboardingId) {
    const created = await query<{ id: string }>(
      `INSERT INTO school_onboarding (school_id, ghl_location_id, school_name, contact_email, stage)
       VALUES ($1, $2, $3, '', 'data')
       RETURNING id`,
      [school.id, locationId, school.name],
    );
    onboardingId = created.rows[0].id;
  }

  const token = mintOnboardingToken(onboardingId);
  redirect(`/onboarding/${token}?chrome=none`);
}
