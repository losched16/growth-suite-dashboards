import type { GhlClient } from './client';

export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  customFields?: Array<{ id: string; value: unknown }>;
  tags?: string[];
  dateAdded?: string;
  dateUpdated?: string;
}

// Fetch one contact's full record by id. Returns null when not found
// or when the API errors out (caller decides whether to retry / log).
export async function getContact(
  client: GhlClient,
  contactId: string,
): Promise<GhlContact | null> {
  try {
    const { data } = await client.axios.get<{ contact?: GhlContact }>(
      `/contacts/${contactId}`,
    );
    return data?.contact ?? null;
  } catch {
    return null;
  }
}

export interface SearchContactsParams {
  client: GhlClient;
  filters?: Array<Record<string, unknown>>;
  pageLimit?: number;
  // Cursor-style pagination: omitted means start from page 1.
  startAfter?: [number, string];
}

// Search contacts. Paginates internally up to `maxPages * pageLimit` results.
export async function searchContacts({
  client,
  filters,
  pageLimit = 100,
  maxPages = 50,
}: SearchContactsParams & { maxPages?: number }): Promise<GhlContact[]> {
  const all: GhlContact[] = [];
  let page = 1;
  while (page <= maxPages) {
    // Retry a single page once on timeout. Large accounts (DGM) sometimes
    // see a transient slow page; without this, one slow request fails the
    // whole sync run. Only timeouts are retried — real 4xx/5xx still throw.
    let data: { contacts?: GhlContact[] } | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ data } = await client.axios.post<{ contacts?: GhlContact[] }>(
          '/contacts/search',
          {
            locationId: client.locationId,
            pageLimit,
            page,
            ...(filters ? { filters } : {}),
          }
        ));
        break;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        const isTimeout = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '');
        if (!isTimeout || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const contacts = data?.contacts ?? [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}

// Search by email — single-match helper used to dedupe before creating.
// GHL's `eq` filter is case-sensitive, but real-world emails aren't. We
// normalize to lowercase before searching, then re-confirm in-memory.
export async function findContactByEmail(
  client: GhlClient,
  email: string,
): Promise<GhlContact | null> {
  if (!email) return null;
  const needle = email.trim().toLowerCase();
  const { data } = await client.axios.post<{ contacts?: GhlContact[] }>(
    '/contacts/search',
    {
      locationId: client.locationId,
      pageLimit: 5,
      page: 1,
      filters: [{ field: 'email', operator: 'eq', value: needle }],
    },
  );
  const list = data.contacts ?? [];
  const match = list.find(
    (c) => (c.email ?? '').trim().toLowerCase() === needle,
  );
  return match ?? null;
}

export async function createContact(
  client: GhlClient,
  input: CreateContactInput,
): Promise<GhlContact> {
  const body: Record<string, unknown> = {
    locationId: client.locationId,
    firstName: input.firstName,
    lastName: input.lastName,
  };
  if (input.email) body.email = input.email;
  if (input.phone) body.phone = input.phone;

  const { data } = await client.axios.post<{ contact: GhlContact }>('/contacts/', body);
  return data.contact;
}

// Upsert: search by email first. If found → return existing (don't touch).
// If not found → create. Used during the parent-2 promotion to avoid
// duplicate contacts when an operator already manually created a P2
// contact and just wants it linked.
export async function upsertContactByEmail(
  client: GhlClient,
  input: CreateContactInput,
): Promise<{ contact: GhlContact; created: boolean }> {
  if (input.email) {
    const existing = await findContactByEmail(client, input.email);
    if (existing) return { contact: existing, created: false };
  }
  const created = await createContact(client, input);
  return { contact: created, created: true };
}
