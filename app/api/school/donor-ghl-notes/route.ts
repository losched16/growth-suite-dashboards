// GET /api/school/donor-ghl-notes?ghl_contact_id=<id>
//
// Fetches the GHL native "Notes" attached to a contact in real time
// and returns them in a stable shape for the donor accordion to
// render. School-session-authed; school_id is read from the cookie so
// the operator can only pull notes for their own school's contacts.
//
// No DB cache for now — lazy fetch keeps the data live. If perf
// becomes a concern (e.g. ~1s per accordion expand annoys the
// operator), the natural next step is a `dp_donor_ghl_notes` cache
// table refreshed by the existing GHL sync.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { loadGhlClient } from '@/lib/ghl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface GhlNote {
  id: string;
  body: string;
  dateAdded?: string;
  userId?: string;
  contactId?: string;
}

interface NoteOut {
  id: string;
  body: string;
  date_added: string | null;
  user_id: string | null;
}

export async function GET(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const ghlContactId = (request.nextUrl.searchParams.get('ghl_contact_id') ?? '').trim();
  if (!ghlContactId) {
    return NextResponse.json({ ok: false, error: 'missing ghl_contact_id' }, { status: 400 });
  }

  try {
    const client = await loadGhlClient(session.school_id);
    const { data } = await client.axios.get<{ notes?: GhlNote[] }>(
      `/contacts/${encodeURIComponent(ghlContactId)}/notes`,
    );
    const raw = data.notes ?? [];
    // Sort newest-first. GHL sometimes returns ascending, sometimes
    // unordered — normalize here so the UI doesn't have to care.
    const notes: NoteOut[] = raw
      .map((n) => ({
        id: n.id,
        body: n.body ?? '',
        date_added: n.dateAdded ?? null,
        user_id: n.userId ?? null,
      }))
      .sort((a, b) => (b.date_added ?? '').localeCompare(a.date_added ?? ''));

    return NextResponse.json({ ok: true, notes, count: notes.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // GHL 404 = contact not found in this location — treat as empty
    // rather than error so the UI shows "no notes" gracefully.
    if (/404|not found/i.test(msg)) {
      return NextResponse.json({ ok: true, notes: [], count: 0, note: 'contact not found in GHL' });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
