// /school/[locationId]/families/[familyId]/pickups
//
// Office management of a family's authorized pickup people. For schools
// where parents can't add their own (parent_managed_pickups=false, e.g.
// DGM), every "please add grandma" email lands here: add the person,
// and the parent can then generate their kiosk PIN from the portal.

import { notFound } from 'next/navigation';
import { UserPlus, Users } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string; familyId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string; chrome?: string }>;

interface PickupRow {
  id: string;
  name: string;
  relationship: string;
  phone: string | null;
  notes: string | null;
  active: boolean;
  pin_set: boolean;
}

export default async function FamilyPickupsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locationId, familyId } = await params;
  const sp = await searchParams;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  const { rows: fam } = await query<{ display_name: string | null }>(
    `SELECT display_name FROM families WHERE id = $1 AND school_id = $2`,
    [familyId, school.id],
  );
  if (fam.length === 0) notFound();

  const { rows: people } = await query<PickupRow>(
    `SELECT pp.id, pp.name, pp.relationship, pp.phone, pp.notes, pp.active,
            (pp.pin_hash IS NOT NULL) AS pin_set
       FROM pickup_persons pp
       LEFT JOIN parents p ON p.id = pp.added_by_parent_id
      WHERE pp.school_id = $1 AND (pp.family_id = $2 OR p.family_id = $2)
      ORDER BY pp.active DESC, pp.name`,
    [school.id, familyId],
  );
  const returnTo = `/school/${locationId}/families/${familyId}/pickups${sp.chrome ? `?chrome=${sp.chrome}` : ''}`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
        <header>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
            <Users className="h-3.5 w-3.5" /> Authorized pickup people
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{fam[0].display_name ?? 'Family'}</h1>
          <p className="mt-1 text-xs text-slate-500">
            People on this list can pick up the family&rsquo;s students at the kiosk once the
            parent generates a PIN for them in the portal. Parents at this school request
            additions through the office — this page is where you add them.
          </p>
        </header>

        {sp.msg ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{sp.msg}</div> : null}
        {sp.err ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{sp.err}</div> : null}

        <section className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-900">
            Currently authorized ({people.filter((p) => p.active).length})
          </div>
          {people.length === 0 ? (
            <div className="px-4 py-5 text-sm italic text-slate-500">No pickup people on file for this family.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {people.map((p) => (
                <li key={p.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${p.active ? '' : 'opacity-50'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">
                      {p.name} <span className="font-normal text-slate-500">· {p.relationship}</span>
                      {!p.active ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">deactivated</span> : null}
                      {p.active && p.pin_set ? <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] uppercase text-emerald-700">PIN set</span> : null}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {p.phone ?? 'no phone'}{p.notes ? ` · ${p.notes}` : ''}
                    </div>
                  </div>
                  {p.active ? (
                    <form action="/api/school/pickup-persons?_method=DELETE" method="POST">
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="return_to" value={returnTo} />
                      <button type="submit" className="rounded border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50">
                        Deactivate
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border-2 border-emerald-200 bg-emerald-50/30 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <UserPlus className="h-4 w-4 text-emerald-700" /> Add someone new
          </div>
          <form action="/api/school/pickup-persons" method="POST" className="space-y-3">
            <input type="hidden" name="family_id" value={familyId} />
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-slate-700">Full name *</span>
                <input type="text" name="name" required maxLength={120} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">Relationship *</span>
                <input type="text" name="relationship" required maxLength={80} placeholder="Grandmother, Nanny…" className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">Phone</span>
                <input type="tel" name="phone" maxLength={40} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-slate-700">Notes</span>
                <input type="text" name="notes" maxLength={200} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
              </label>
            </div>
            <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700">
              Add to authorized list
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
