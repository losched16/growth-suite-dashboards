import Link from 'next/link';
import type { WidgetDefinition, SchoolContext } from '@/lib/widgets/types';
import { familyListTableDefaults, familyListTableSchema, type FamilyListTableConfig } from './config';
import { fetcher, type FamilyListTableData } from './fetcher';

function FamilyListTableComponent({
  school,
  data,
}: {
  school: SchoolContext;
  data: FamilyListTableData;
}) {
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <strong className="block mb-1">No families in the family graph yet.</strong>
        Run the intake endpoint or the bulk import to populate. Until then this widget renders empty.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Families</h3>
        <div className="text-xs text-gray-500">
          {data.totals.families} families · {data.totals.students} students
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50">
          <tr>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Family</th>
            <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">Parents</th>
            <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">Students</th>
            <th className="text-center px-3 py-2 text-xs font-semibold text-gray-700">This year</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700">Status</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.family_id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 font-medium text-gray-900">
                <Link
                  href={`/school/${school.locationId}/${data.drilldown_slug}/${r.family_id}`}
                  className="hover:underline"
                >
                  {r.display_name}
                </Link>
              </td>
              <td className="text-center px-3 py-2 text-gray-700">{r.parent_count}</td>
              <td className="text-center px-3 py-2 text-gray-700">{r.student_count}</td>
              <td className="text-center px-3 py-2 text-gray-700">{r.current_year_enrollment_count}</td>
              <td className="px-3 py-2 text-xs text-gray-500">{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const FamilyListTable: WidgetDefinition<FamilyListTableConfig, FamilyListTableData> = {
  id: 'family_list_table',
  display_name: 'Family List Table',
  description: 'Sortable table of all families with summary status. Click-through to detail.',
  category: 'family',
  default_config: familyListTableDefaults,
  config_schema: familyListTableSchema,
  default_size: { w: 12, h: 6 },
  Component: FamilyListTableComponent,
  dataFetcher: fetcher,
};
