// GET /api/admin/schools/{schoolId}/ghl/contact-search?q=<text>
//
// Typeahead over the school's GoHighLevel contacts, for the "invoice
// anyone" recipient picker. Uses the school's PIT token. Returns a
// small, flat list — id, name, email, phone — enough to populate the
// invoice recipient fields.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadGhlClient } from '@/lib/ghl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

interface GhlSearchContact {
  id: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  email?: string | null;
  phone?: string | null;
}

export async function GET(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ contacts: [] });

  let client;
  try {
    client = await loadGhlClient(schoolId);
  } catch {
    return NextResponse.json({ error: 'ghl_not_connected', detail: 'This school has no GHL token configured.' }, { status: 400 });
  }

  try {
    // GHL's /contacts/search accepts a plain `query` for typeahead.
    const { data } = await client.axios.post<{ contacts?: GhlSearchContact[] }>(
      '/contacts/search',
      { locationId: client.locationId, query: q, pageLimit: 20, page: 1 },
    );
    const contacts = (data.contacts ?? []).map((c) => {
      const name = (c.contactName
        ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).trim();
      return {
        id: c.id,
        name: name || c.email || '(no name)',
        first_name: c.firstName ?? '',
        last_name: c.lastName ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
      };
    }).filter((c) => c.email); // an invoice needs an email to send to
    return NextResponse.json({ contacts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'ghl_search_failed', detail: msg }, { status: 502 });
  }
}
