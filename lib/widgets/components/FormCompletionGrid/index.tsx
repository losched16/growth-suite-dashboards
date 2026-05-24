import type { WidgetDefinition } from '@/lib/widgets/types';
import { formCompletionGridDefaults, formCompletionGridSchema, type FormCompletionGridConfig } from './config';
import { fetcher, type FormCompletionGridData } from './fetcher';

const EMDASH = '—';

function fmtDate(s: string): string {
  if (!s) return EMDASH;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function FormCompletionGridComponent({ data }: { data: FormCompletionGridData }) {
  if (data.forms.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Configure this widget with at least one form field to track.
      </div>
    );
  }
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No families match the current filter.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Form completion</h3>
        <div className="text-xs text-gray-500">
          {data.totals.fully_complete_families} of {data.totals.families} fully complete · {data.forms.length} forms tracked
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700 sticky left-0 bg-gray-50 min-w-[200px]">
                Family
              </th>
              <th className="text-center px-2 py-2 text-xs font-semibold text-gray-700">%</th>
              {data.forms.map((f) => (
                <th key={f.field_key} className="px-2 py-2 text-xs font-semibold text-gray-700 text-center align-bottom">
                  <div className="rotate-[-15deg] inline-block whitespace-nowrap text-[11px]">
                    {f.display_name}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const pct = row.total_count === 0 ? 0 : Math.round((row.completed_count / row.total_count) * 100);
              const pctColor = pct === 100 ? 'text-emerald-700' : pct === 0 ? 'text-red-700' : 'text-amber-700';
              return (
                <tr key={row.contact_id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 sticky left-0 bg-white">
                    <div className="font-medium text-gray-900">{row.family_label}</div>
                    {row.email ? (
                      <div className="text-[11px] text-gray-500 truncate max-w-[220px]">{row.email}</div>
                    ) : null}
                  </td>
                  <td className={`text-center px-2 py-2 text-xs font-semibold ${pctColor}`}>{pct}%</td>
                  {data.forms.map((f) => {
                    const completedAt = row.completion[f.field_key];
                    return (
                      <td key={f.field_key} className="text-center px-2 py-2">
                        {completedAt ? (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold"
                            title={`Completed ${fmtDate(completedAt)}`}
                          >
                            ✓
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-xs font-bold"
                            title="Not completed"
                          >
                            ✗
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const FormCompletionGrid: WidgetDefinition<FormCompletionGridConfig, FormCompletionGridData> = {
  id: 'form_completion_grid',
  display_name: 'Form Completion Grid',
  description: 'Families × forms grid showing completion status per cell.',
  category: 'documents',
  default_config: formCompletionGridDefaults,
  config_schema: formCompletionGridSchema,
  default_size: { w: 12, h: 6 },
  Component: FormCompletionGridComponent,
  dataFetcher: fetcher,
};
