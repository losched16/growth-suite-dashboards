// Tuition Grids tab — list, inline add, edit, deactivate.
//
// A "grid" = one (program × schedule) row on the school's rate card.
// (e.g. "YC — 5 Days, Full Day @ $13,300/yr"). Pair with payment plans
// (different installment frequencies) to form a complete tuition setup
// for a family enrollment.
//
// Replaces the per-school custom seed scripts (seed-mch-tuition.mjs,
// _reseed_dgm_tuition.mjs) for ongoing grid management. Operators
// adjust grids in-iframe; no script runs needed.

import { Plus, Edit3, Power, PowerOff } from 'lucide-react';
import { query } from '@/lib/db';

interface GridRow {
  id: string;
  academic_year: string;
  program: string;
  grade_level: string | null;
  display_name: string;
  annual_tuition_cents: number;
  is_active: boolean;
  position: number;
}

export async function PaymentsHubGrids({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const { rows } = await query<GridRow>(
    `SELECT id, academic_year, program, grade_level, display_name,
            annual_tuition_cents, is_active, position
       FROM tuition_grids
      WHERE school_id = $1
      ORDER BY academic_year DESC, position, display_name`,
    [schoolId],
  );

  // Group by academic year for readability — schools usually keep prior
  // years around for accounting reference.
  const byYear = new Map<string, GridRow[]>();
  for (const r of rows) {
    if (!byYear.has(r.academic_year)) byYear.set(r.academic_year, []);
    byYear.get(r.academic_year)!.push(r);
  }
  const years = Array.from(byYear.keys());

  // Default the "Add" form's academic year to the most-recent year on
  // file, or the current school year if no rows exist yet.
  const currentYear = (() => {
    const y = new Date().getFullYear();
    return new Date().getMonth() >= 6 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
  })();
  const defaultYear = years[0] ?? currentYear;

  const apiUrl = '/api/school/tuition-grids/save';
  const returnTo = `/school/${locationId}/payments?tab=grids`;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Tuition Grids</h2>
        <p className="text-sm text-slate-500">
          Your rate card. One row per (program × schedule) combo. Used by enrollments to compute amounts owed.
        </p>
      </div>

      {/* ── Add new grid ──────────────────────────────────────────── */}
      <details className="rounded-lg border-2 border-blue-200 bg-blue-50/30 overflow-hidden">
        <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-sm font-semibold text-blue-900 hover:bg-blue-50">
          <Plus className="h-4 w-4" />
          Add a new grid
          <span className="text-[11px] font-normal text-blue-700 ml-1">— a new program/schedule combo on your rate card</span>
        </summary>

        <form action={apiUrl} method="POST" className="px-4 pb-4 pt-2 space-y-3 border-t border-blue-100 bg-white">
          <input type="hidden" name="op" value="add" />
          <input type="hidden" name="return_to" value={returnTo} />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Academic year" required hint='Format: YYYY-YY, e.g. "2026-27".'>
              <input type="text" name="academic_year" required pattern="\d{4}-\d{2}" defaultValue={defaultYear}
                     placeholder="2026-27" className={inputCls + ' font-mono'} />
            </Field>
            <Field label="Display name" required hint="What admins see in the enrollment editor.">
              <input type="text" name="display_name" required maxLength={120}
                     placeholder="e.g. Primary — 5 Days, Full Day" className={inputCls} />
            </Field>
            <Field label="Position" hint="Sort order in lists. Lower = first.">
              <input type="number" name="position" min={0} defaultValue={(rows.length * 10).toString()}
                     className={inputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Program" required hint='Schedule-specific name, e.g. "Primary — 5 Days, Full Day". Must be unique per grade level.'>
              <input type="text" name="program" required maxLength={120}
                     placeholder="e.g. Primary — 5 Days, Full Day" className={inputCls} />
            </Field>
            <Field label="Grade level" required hint='Broad bucket: "Young Community", "Primary", "Kindergarten", etc. Same value across schedules.'>
              <input type="text" name="grade_level" required maxLength={60}
                     placeholder="e.g. Primary" className={inputCls} />
            </Field>
            <Field label="Annual tuition ($)" required hint="Before plan discounts. Just the tuition number from your rate card.">
              <input type="number" step="0.01" min="0" name="annual_tuition_dollars" required
                     placeholder="e.g. 12800" className={inputCls + ' font-mono text-right'} />
            </Field>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Create grid
            </button>
            <p className="text-[11px] text-slate-500">
              Existing enrollments aren&rsquo;t affected. New enrollments can pick this grid immediately.
            </p>
          </div>
        </form>
      </details>

      {/* ── Existing grids, grouped by year ───────────────────────── */}
      {years.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 italic">
          No tuition grids yet. Add your first one above — most schools have one per (program × schedule) combo on their rate card.
        </div>
      ) : years.map((yr) => (
        <section key={yr} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900 flex items-center justify-between">
            <span>{yr}</span>
            <span className="text-xs font-normal text-slate-500">
              {byYear.get(yr)!.length} grid{byYear.get(yr)!.length === 1 ? '' : 's'}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Display name</th>
                <th className="px-4 py-2 font-medium">Program</th>
                <th className="px-4 py-2 font-medium">Grade level</th>
                <th className="px-4 py-2 font-medium text-right">Annual</th>
                <th className="px-4 py-2 font-medium text-right">Position</th>
                <th className="px-4 py-2 font-medium text-center">Active</th>
                <th className="px-4 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byYear.get(yr)!.map((g) => (
                <GridRowEditor
                  key={g.id}
                  grid={g}
                  apiUrl={apiUrl}
                  returnTo={returnTo}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <p className="text-[11px] text-slate-500">
        Grid prices are <strong>annual</strong> amounts <em>before</em> plan discounts. Payment plans
        (configured separately) apply their discounts on top. Pairing a grid + plan + family creates an
        enrollment in the family-tuition-enrollments table.
      </p>
    </div>
  );
}

// ── Per-row editor: inline edit, deactivate, reactivate ────────────
function GridRowEditor({
  grid, apiUrl, returnTo,
}: { grid: GridRow; apiUrl: string; returnTo: string }) {
  return (
    <tr className={`hover:bg-slate-50 ${!grid.is_active ? 'opacity-60' : ''}`}>
      <td className="px-4 py-2 text-slate-900">{grid.display_name}</td>
      <td className="px-4 py-2 text-xs text-slate-700">{grid.program}</td>
      <td className="px-4 py-2 text-xs text-slate-700">{grid.grade_level ?? '—'}</td>
      <td className="px-4 py-2 text-right font-mono text-sm text-slate-900 tabular-nums">
        ${(grid.annual_tuition_cents / 100).toLocaleString()}
      </td>
      <td className="px-4 py-2 text-right text-xs tabular-nums text-slate-500">{grid.position}</td>
      <td className="px-4 py-2 text-center">
        {grid.is_active
          ? <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 uppercase">Active</span>
          : <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 uppercase">Inactive</span>
        }
      </td>
      <td className="px-4 py-2 text-right">
        <details className="inline-block">
          <summary className="cursor-pointer list-none inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
            <Edit3 className="h-3 w-3" /> Edit
          </summary>
          <form action={apiUrl} method="POST" className="absolute right-4 z-10 mt-1 w-72 rounded-md border border-slate-300 bg-white p-3 shadow-lg space-y-2">
            <input type="hidden" name="op" value="update" />
            <input type="hidden" name="id" value={grid.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Display name</span>
              <input type="text" name="display_name" required defaultValue={grid.display_name} className={inputCls} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Annual ($)</span>
              <input type="number" step="0.01" min="0" name="annual_tuition_dollars" required
                     defaultValue={(grid.annual_tuition_cents / 100).toFixed(2)}
                     className={inputCls + ' font-mono text-right'} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Position</span>
              <input type="number" name="position" min={0} defaultValue={grid.position} className={inputCls} />
            </label>
            <button type="submit" className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700">
              Save
            </button>
          </form>
        </details>
        {' '}
        {grid.is_active ? (
          <form action={apiUrl} method="POST" className="inline">
            <input type="hidden" name="op" value="deactivate" />
            <input type="hidden" name="id" value={grid.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700"
              title="Deactivate — new enrollments can't pick it. Existing enrollments still reference it."
            >
              <Power className="h-3 w-3" /> Deactivate
            </button>
          </form>
        ) : (
          <form action={apiUrl} method="POST" className="inline">
            <input type="hidden" name="op" value="reactivate" />
            <input type="hidden" name="id" value={grid.id} />
            <input type="hidden" name="return_to" value={returnTo} />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700"
            >
              <PowerOff className="h-3 w-3" /> Reactivate
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}

// ── Form input helpers (same as Discounts.tsx) ─────────────────────
const inputCls =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200';

function Field({
  label, required, hint, children,
}: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </span>
      {hint ? <span className="block text-[10px] text-slate-500 mt-0.5">{hint}</span> : null}
      {children}
    </label>
  );
}
