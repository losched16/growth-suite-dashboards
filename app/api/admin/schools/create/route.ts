// Onboard a new school. Form fields:
//   - name (required)
//   - ghl_location_id (required) — from GHL Settings → Business Info
//   - ghl_pit (required) — Private Integration Token with scopes:
//       contacts.readonly, contacts.write,
//       locations/customFields.readonly,
//       associations.write, associations/relation.write,
//       opportunities.readonly, conversations.readonly, conversations/message.write
//
// Behavior:
//   1. Validates the PIT by hitting /locations/{id}/customFields
//   2. AES-256-GCM encrypts the PIT
//   3. Inserts row into schools
//   4. Redirects to /admin/{newSchoolId} for sync + promote-p2

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import axios from 'axios';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const locationId = String(form.get('ghl_location_id') ?? '').trim();
    const pit = String(form.get('ghl_pit') ?? '').trim();

    if (!name) return back(request, { err: 'School name is required.' });
    if (!locationId) return back(request, { err: 'GHL Location ID is required.' });
    if (!pit) return back(request, { err: 'GHL Private Integration Token is required.' });

    // Reject obvious duplicate location_id up-front (saves a round-trip)
    const { rows: dup } = await query<{ id: string }>(
      `SELECT id FROM schools WHERE ghl_location_id = $1`,
      [locationId],
    );
    if (dup.length > 0) {
      return back(request, {
        err: `A school with this GHL Location ID already exists (id ${dup[0].id.slice(0, 8)}…).`,
      });
    }

    // Probe GHL to validate the PIT before storing anything
    try {
      await axios.get(`https://services.leadconnectorhq.com/locations/${locationId}/customFields`, {
        headers: {
          Authorization: `Bearer ${pit}`,
          Version: '2021-07-28',
          Accept: 'application/json',
        },
        timeout: 10_000,
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      return back(request, {
        err: `Couldn't validate PIT against GHL (HTTP ${status ?? '?'}): ${msg ?? 'check that the location ID is correct and the PIT has the customFields scope'}`,
      });
    }

    // Encrypt + insert
    const { ciphertext, iv, tag } = encrypt(pit);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO schools (name, ghl_location_id, ghl_pit_encrypted, ghl_pit_iv, ghl_pit_tag)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, locationId, ciphertext, iv, tag],
    );

    const schoolId = rows[0].id;
    const url = request.nextUrl.clone();
    url.pathname = `/admin/${schoolId}`;
    url.search = '';
    url.searchParams.set('msg', `Created "${name}". Run "Sync from GHL" next to pull their families.`);
    return NextResponse.redirect(url, 303);
  } catch (err) {
    return back(request, {
      err: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function back(request: NextRequest, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = '/admin/schools/new';
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
