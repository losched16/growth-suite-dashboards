import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import { familyDetailCardDefaults, familyDetailCardSchema, type FamilyDetailCardConfig } from './config';
import { fetcher, type FamilyDetailCardData } from './fetcher';

const EMDASH = '—';

// Build the GHL contact-detail URL the operator uses to message a parent.
// We never label this as GHL — just "Open contact record".
function contactRecordUrl(locationId: string, ghlContactId: string): string {
  const base = process.env.CRM_APP_BASE ?? 'https://app.mygrowthsuite.com';
  return `${base}/v2/location/${locationId}/contacts/detail/${ghlContactId}`;
}

function FamilyDetailCardComponent({
  school,
  data,
}: {
  school: SchoolContext;
  data: FamilyDetailCardData;
}) {
  if (!data.family_id) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No family selected. This widget is for the Family Hub detail view.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{data.display_name}</h2>
          <div className="text-xs text-gray-500 mt-0.5">
            status: <span className="font-mono">{data.status}</span> · {data.student_count} student{data.student_count === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {data.notes ? (
        <p className="text-sm text-gray-700 whitespace-pre-wrap border-l-2 border-gray-200 pl-3">{data.notes}</p>
      ) : null}

      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold mb-2">Parents</div>
        {data.parents.length === 0 ? (
          <div className="text-sm text-gray-500">No parents on file.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.parents.map((p) => (
              <div key={p.id} className="rounded-md border border-gray-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-medium text-gray-900">{p.name || '(unnamed)'}</div>
                  {p.is_primary ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">primary</span>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-gray-600">{p.email || EMDASH}</div>
                <div className="text-xs text-gray-600">{p.phone || EMDASH}</div>
                {p.ghl_contact_id ? (
                  <a
                    href={contactRecordUrl(school.locationId, p.ghl_contact_id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-[11px] text-emerald-700 hover:underline"
                  >
                    Open contact record ↗
                  </a>
                ) : (
                  <div className="mt-2 text-[11px] text-amber-600">no contact record synced</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const FamilyDetailCard: WidgetDefinition<FamilyDetailCardConfig, FamilyDetailCardData> = {
  id: 'family_detail_card',
  display_name: 'Family Detail Card',
  description: 'Detailed view for one family: parents (with contact link), notes, student count.',
  category: 'family',
  default_config: familyDetailCardDefaults,
  config_schema: familyDetailCardSchema,
  default_size: { w: 12, h: 4 },
  Component: FamilyDetailCardComponent,
  dataFetcher: fetcher,
};
