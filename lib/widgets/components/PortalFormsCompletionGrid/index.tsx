import type { WidgetDefinition } from '@/lib/widgets/types';
import {
  portalFormsCompletionGridDefaults,
  portalFormsCompletionGridSchema,
  type PortalFormsCompletionGridConfig,
} from './config';
import { fetcher, type PortalFormsCompletionGridData } from './fetcher';

function fmtDate(s: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Cell({
  status, submitted_at,
}: { status: string; submitted_at: string | null }) {
  if (status === 'submitted' || status === 'paid') {
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold"
        title={submitted_at ? `Submitted ${fmtDate(submitted_at)}` : 'Submitted'}
      >
        ✓
      </span>
    );
  }
  if (status === 'pending_payment') {
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold"
        title="Pending payment"
      >
        $
      </span>
    );
  }
  if (status === 'voided') {
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-gray-500 text-xs font-bold"
        title="Voided"
      >
        ⊘
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-xs font-bold"
      title="Not submitted"
    >
      ✗
    </span>
  );
}

function PortalFormsCompletionGridComponent({ data }: { data: PortalFormsCompletionGridData }) {
  if (data.forms.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No portal form definitions exist for this school. Seed them via the
        operator script or add rows to <code>portal_form_definitions</code>.
      </div>
    );
  }
  if (data.rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No students match the current filter.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Portal forms completion</h3>
        <div className="text-xs text-gray-500">
          {data.totals.fully_complete_students} of {data.totals.students} students fully complete
          ({data.totals.pct}%) · {data.forms.length} forms tracked · {data.totals.total_submissions} submissions
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-semibold text-gray-700 sticky left-0 bg-gray-50 min-w-[220px]">
                Student
              </th>
              {data.forms.map((f) => (
                <th key={f.id} className="px-2 py-2 text-xs font-semibold text-gray-700 text-center align-bottom" title={f.display_name}>
                  <div className="rotate-[-15deg] inline-block whitespace-nowrap text-[11px]">
                    {f.display_name}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.student_id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2 sticky left-0 bg-white">
                  <div className="font-medium text-gray-900">{row.student_label}</div>
                  <div className="text-[11px] text-gray-500 truncate max-w-[260px]">
                    {row.family_label}
                  </div>
                </td>
                {data.forms.map((f) => {
                  const cell = row.cells[f.id];
                  return (
                    <td key={f.id} className="text-center px-2 py-2">
                      <Cell status={cell.status} submitted_at={cell.submitted_at} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const PortalFormsCompletionGrid: WidgetDefinition<PortalFormsCompletionGridConfig, PortalFormsCompletionGridData> = {
  id: 'portal_forms_completion_grid',
  display_name: 'Portal Forms Completion',
  description: 'Students × forms grid showing completion status (driven by portal-form submissions).',
  category: 'documents',
  default_config: portalFormsCompletionGridDefaults,
  config_schema: portalFormsCompletionGridSchema,
  default_size: { w: 12, h: 6 },
  Component: PortalFormsCompletionGridComponent,
  dataFetcher: fetcher,
};
