// GHL Associations API — operator-side copy used by the
// "Promote Parent 2 to its own contact" migration. Stays in lock-step
// with growth-suite-family-graph/lib/ghl/associations.ts.
//
// Two-step concept:
//   1. Association (type/schema): defined once per location per relationship.
//      e.g. "co_parent" with labels "Co-Parent" on both sides.
//   2. Relation (instance): two records linked using an existing association.
//
// `linkContacts()` is the convenience: ensure-then-relate.

import type { GhlClient } from './client';

interface AssociationResponse {
  id?: string;
  associationId?: string;
  key?: string;
}

interface RelationResponse {
  id?: string;
  relationId?: string;
}

async function findAssociationByKey(client: GhlClient, key: string): Promise<string | null> {
  try {
    const { data } = await client.axios.get<AssociationResponse>(
      `/associations/key/${encodeURIComponent(key)}`,
      { params: { locationId: client.locationId } },
    );
    return data.id ?? data.associationId ?? null;
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string } } };
    // GHL returns 404 OR 400 "Association not found" for missing associations.
    // Treat both as "not found" so callers can fall through to create.
    if (e.response?.status === 404) return null;
    if (e.response?.status === 400 && /not\s*found/i.test(e.response?.data?.message ?? '')) {
      return null;
    }
    throw err;
  }
}

export async function findOrCreateAssociation(
  client: GhlClient,
  params: {
    key: string;
    firstLabel: string;
    secondLabel?: string;
  },
): Promise<string> {
  const existing = await findAssociationByKey(client, params.key);
  if (existing) return existing;

  // GHL rejects associations with identical first/second labels (422
  // "Both object labels can not be same"). For symmetric relationships
  // like co_parent we differentiate by appending " (linked)" to the
  // second side so the underlying meaning is preserved but GHL is happy.
  let firstLabel = params.firstLabel;
  let secondLabel = params.secondLabel ?? params.firstLabel;
  if (firstLabel === secondLabel) {
    secondLabel = `${firstLabel} (linked)`;
  }

  const { data } = await client.axios.post<AssociationResponse>('/associations/', {
    locationId: client.locationId,
    key: params.key,
    firstObjectLabel: firstLabel,
    firstObjectKey: 'contact',
    secondObjectLabel: secondLabel,
    secondObjectKey: 'contact',
  });
  const id = data.id ?? data.associationId;
  if (!id) throw new Error('Create association response missing id');
  return id;
}

// Returns the relation id, OR null if the relation already existed (GHL
// rejects duplicates with 400 "duplicate relation of object Ids"). Callers
// treat null as "already linked — no action needed".
export async function createRelation(
  client: GhlClient,
  params: { associationId: string; firstRecordId: string; secondRecordId: string },
): Promise<string | null> {
  try {
    const { data } = await client.axios.post<RelationResponse>('/associations/relations', {
      locationId: client.locationId,
      associationId: params.associationId,
      firstRecordId: params.firstRecordId,
      secondRecordId: params.secondRecordId,
    });
    const id = data.id ?? data.relationId;
    if (!id) throw new Error('Create relation response missing id');
    return id;
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string } } };
    // GHL returns 400 "Could not create relation: duplicate relation of
    // object Ids for given association" when the same two records are
    // already linked. That's idempotent-OK — caller just needed the link
    // to exist.
    if (
      e.response?.status === 400 &&
      /duplicate\s+relation/i.test(e.response?.data?.message ?? '')
    ) {
      return null;
    }
    throw err;
  }
}

// Convenience: ensure the association type exists, then create the relation.
export async function linkContacts(
  client: GhlClient,
  params: {
    relationship: string;
    label?: string;
    firstContactId: string;
    secondContactId: string;
  },
): Promise<{ associationId: string; relationId: string | null; alreadyLinked: boolean }> {
  const key = normalizeKey(params.relationship);
  const label = params.label ?? prettyLabel(params.relationship);

  const associationId = await findOrCreateAssociation(client, { key, firstLabel: label });
  const relationId = await createRelation(client, {
    associationId,
    firstRecordId: params.firstContactId,
    secondRecordId: params.secondContactId,
  });
  return { associationId, relationId, alreadyLinked: relationId === null };
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function prettyLabel(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}
