// Tuition Plans tab — TWO sections:
//
//   1. PLAN TEMPLATES — reusable payment schedules (e.g. "Monthly × 10",
//      "Annual lump sum (3% discount)", "Semi-annual"). School staff
//      create / edit / deactivate these here. Without at least one
//      active template, no family can be put on a plan.
//
//   2. FAMILY ENROLLMENTS — families currently assigned to a template +
//      grid. "Start an enrollment" sends the parent a magic link to
//      pick their own plan via the portal.
//
// Templates POST to /api/admin/schools/{schoolId}/payments/plans with a
// hidden `return_to` so we land back here, not in the operator console.

import Link from 'next/link';
import { Plus, Trash2, Sparkles, Edit3, X, Pencil, Search } from 'lucide-react';
import { query } from '@/lib/db';
import { HelpCallout } from '@/components/HelpCallout';

interface EnrollmentRow {
  id: string;
  family_label: string;
  student_label: string | null;
  academic_year: string;
  grid_label: string;
  plan_label: string;
  total_annual_cents: number;
  installment_count: number;
  status: string;
  // Null = standard tuition. 0 = scholarship badge. >0 = custom-tuition badge.
  tuition_override_cents: number | null;
  invoices_open: number;
  invoices_paid: number;
  amount_paid_cents: number;
}

interface PlanTemplateRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  installment_count: number;
  discount_basis_points: number;
  first_due_month_day: string | null;
  is_active: boolean;
  position: number;
  in_use_count: number;
}

export async function PaymentsHubPlans({
  schoolId, locationId, editTemplateId = null, familySearch = '',
}: {
  schoolId: string;
  locationId: string;
  editTemplateId?: string | null;
  // Substring filter applied to family name / student name / primary
  // parent name + email. Drives both the SQL WHERE and the search input
  // (so the input keeps the typed value on rerender). Bound to `?q=`.
  familySearch?: string;
}) {
  // Normalize the search term for case-insensitive matching. Empty
  // string means "no filter" — handled by passing NULL to the SQL,
  // which the WHERE branches on.
  const q = familySearch.trim();
  const qParam = q ? `%${q.toLowerCase()}%` : null;

  const [{ rows: enrollments }, { rows: planTemplates }] = await Promise.all([
    query<EnrollmentRow>(
      `SELECT e.id,
              COALESCE(NULLIF(f.display_name, ''),
                       CONCAT_WS(' ', p.first_name, p.last_name),
                       '(unnamed)') AS family_label,
              CASE WHEN st.id IS NOT NULL
                   THEN CONCAT_WS(' ', COALESCE(NULLIF(st.preferred_name, ''), st.first_name), st.last_name)
                   ELSE NULL END AS student_label,
              e.academic_year,
              g.display_name AS grid_label,
              pl.display_name AS plan_label,
              e.total_annual_cents,
              e.installment_count,
              e.status,
              e.tuition_override_cents,
              (SELECT COUNT(*)::int FROM invoices WHERE source = 'tuition_plan'
                AND source_ref->>'enrollment_id' = e.id::text
                AND status IN ('open', 'partially_paid')) AS invoices_open,
              (SELECT COUNT(*)::int FROM invoices WHERE source = 'tuition_plan'
                AND source_ref->>'enrollment_id' = e.id::text
                AND status = 'paid') AS invoices_paid,
              (SELECT COALESCE(SUM(amount_paid_cents), 0)::int FROM invoices
                WHERE source = 'tuition_plan'
                  AND source_ref->>'enrollment_id' = e.id::text) AS amount_paid_cents
         FROM family_tuition_enrollments e
         JOIN families f ON f.id = e.family_id
         JOIN tuition_grids g ON g.id = e.tuition_grid_id
         JOIN payment_plans pl ON pl.id = e.payment_plan_id
         LEFT JOIN students st ON st.id = e.student_id
         LEFT JOIN LATERAL (
           SELECT first_name, last_name, email FROM parents
            WHERE family_id = f.id AND is_primary = true LIMIT 1
         ) p ON true
        WHERE e.school_id = $1
          AND ($2::text IS NULL OR (
            -- family display name
            lower(COALESCE(f.display_name, '')) LIKE $2
            -- primary parent first + last
            OR lower(COALESCE(p.first_name, '')) LIKE $2
            OR lower(COALESCE(p.last_name, '')) LIKE $2
            OR lower(COALESCE(p.email, '')) LIKE $2
            -- student name(s) — match against ANY student in the family,
            -- not just the one tied to the enrollment, so a parent
            -- searching by sibling name still finds the enrollment row.
            OR EXISTS (
              SELECT 1 FROM students sx
               WHERE sx.family_id = f.id
                 AND (lower(sx.first_name) LIKE $2 OR lower(sx.last_name) LIKE $2
                      OR lower(COALESCE(sx.preferred_name, '')) LIKE $2)
            )
          ))
        ORDER BY e.status, e.academic_year DESC, family_label
        LIMIT 200`,
      [schoolId, qParam],
    ),
    query<PlanTemplateRow>(
      `SELECT pl.id, pl.slug, pl.display_name, pl.description,
              pl.installment_count, pl.discount_basis_points,
              pl.first_due_month_day, pl.is_active, pl.position,
              (SELECT COUNT(*)::int FROM family_tuition_enrollments e
                 WHERE e.payment_plan_id = pl.id) AS in_use_count
         FROM payment_plans pl
        WHERE pl.school_id = $1
        ORDER BY pl.is_active DESC, pl.position ASC, pl.created_at ASC`,
      [schoolId],
    ),
  ]);

  const returnTo = `/school/${locationId}/payments?tab=plans`;
  const apiBase = `/api/admin/schools/${schoolId}/payments/plans`;
  const activeTemplateCount = planTemplates.filter((p) => p.is_active).length;
  const missingStartCount = planTemplates.filter((p) => p.is_active && !p.first_due_month_day).length;

  return (
    <div className="space-y-6">
      {/* ─── SECTION 1: PLAN TEMPLATES ─── */}
      <section>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Payment plan templates</h2>
            <p className="text-sm text-slate-500">
              Reusable payment schedules. Define them once; assign them to families when you enroll.
            </p>
          </div>
          <div className="text-xs text-slate-500">
            {activeTemplateCount} active · {planTemplates.length} total
          </div>
        </div>

        <HelpCallout
          title="How payment plan templates work"
          defaultOpen={planTemplates.length === 0}
          steps={[
            <>A <strong>template</strong> describes how a family pays: number of installments, when the first payment is due, and an optional prompt-pay discount. The actual amounts come from the family&apos;s tuition grid.</>,
            <>Common setups: <em>Annual</em> (1 payment, small discount), <em>Semi-annual</em> (2 payments), <em>Quarterly</em> (4), <em>Monthly × 10</em> (Aug–May), <em>Monthly × 12</em>. Add as many as you want.</>,
            <><strong>First payment due</strong> sets the anchor — e.g. &ldquo;Aug 1.&rdquo; The year is auto-derived from each family&rsquo;s academic year, so a template configured once works every year. Leave it blank to use the default (1st of each month for monthly schedules, Aug 15 for single annual).</>,
            <>The <strong>discount %</strong> is applied to the total tuition before installments are calculated. Use it to reward families who pay upfront.</>,
            <>You can&rsquo;t hard-delete a template that&rsquo;s already in use by enrolled families — deactivate it instead to hide it from future enrollments while preserving history.</>,
          ]}
        />

        {missingStartCount > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 mb-2">
            <strong>Heads up:</strong> {missingStartCount} active template{missingStartCount === 1 ? ' has' : 's have'} no &ldquo;first payment due&rdquo; date set, so they fall back to defaults (1st of each month for monthly, Aug 15 for annual).
            Click <strong>Edit</strong> on any row below to set an explicit start date.
          </div>
        ) : null}

        {planTemplates.length === 0 ? (
          <EmptyTemplatesPanel apiBase={apiBase} returnTo={returnTo} />
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-center">Installments</th>
                  <th className="px-3 py-2 font-medium text-center">First payment due</th>
                  <th className="px-3 py-2 font-medium text-right">Prompt-pay discount</th>
                  <th className="px-3 py-2 font-medium text-center">In use</th>
                  <th className="px-3 py-2 font-medium text-center">Active</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {planTemplates.map((p) => (
                  <PlanTemplateRow
                    key={p.id}
                    template={p}
                    apiBase={apiBase}
                    returnTo={returnTo}
                    locationId={locationId}
                    isEditing={editTemplateId === p.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Always-visible "Add new template" form */}
        <AddTemplateForm apiBase={apiBase} returnTo={returnTo} />
      </section>

      {/* ─── SECTION 2: FAMILY ENROLLMENTS ─── */}
      <section>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Family enrollments</h2>
            <p className="text-sm text-slate-500">
              <strong>Click any row</strong> to open the family&rsquo;s plan editor — change due dates, change amounts,
              apply a scholarship, split a single payment into two, reschedule the remaining balance across
              more (or fewer) months, or pause / resume the plan.
            </p>
          </div>
          {activeTemplateCount > 0 ? (
            <Link
              href={`/school/${locationId}/enrollments/start`}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Enroll a family
            </Link>
          ) : (
            <span className="text-xs text-amber-700 italic">
              Add at least one plan template above before enrolling families.
            </span>
          )}
        </div>

        {/* Family search — GET form scoped to the Plans tab so the URL
            keeps ?tab=plans and the search term as ?q=. Auto-submits on
            text change (Enter triggers submit; clearing via the X link
            preserves the tab). */}
        <form method="GET" className="mb-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
          {/* Preserve tab=plans so the GET submission stays on this tab */}
          <input type="hidden" name="tab" value="plans" />
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search families by name, student name, parent name, or email…"
            className="flex-1 min-w-0 border-0 bg-transparent text-sm focus:outline-none focus:ring-0 placeholder:text-slate-400"
          />
          <button type="submit" className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">
            Search
          </button>
          {q ? (
            <Link
              href={`/school/${locationId}/payments?tab=plans`}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              Clear
            </Link>
          ) : null}
        </form>
        {q ? (
          <p className="mb-2 text-xs text-slate-500">
            Showing {enrollments.length} result{enrollments.length === 1 ? '' : 's'} for &ldquo;<span className="font-semibold">{q}</span>&rdquo;.
          </p>
        ) : null}

        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Family</th>
                <th className="px-4 py-2.5 font-medium">Program · Plan</th>
                <th className="px-4 py-2.5 font-medium">Year</th>
                <th className="px-4 py-2.5 font-medium text-right">Annual</th>
                <th className="px-4 py-2.5 font-medium">Progress</th>
                <th className="px-4 py-2.5 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {enrollments.length === 0 ? (
                <tr><td colSpan={6} className="p-10 text-center text-sm text-slate-500 italic">
                  {q ? (
                    <>No families match &ldquo;<span className="font-semibold">{q}</span>&rdquo;. Try a different search term or <Link href={`/school/${locationId}/payments?tab=plans`} className="text-blue-600 hover:underline">clear the filter</Link>.</>
                  ) : (
                    <>No enrollments yet. Click <strong>Start an enrollment</strong> to set up the first family.</>
                  )}
                </td></tr>
              ) : enrollments.map((e) => {
                const pct = e.total_annual_cents > 0 ? Math.round((e.amount_paid_cents / e.total_annual_cents) * 100) : 0;
                const planHref = `/school/${locationId}/payments/plans/${e.id}`;
                return (
                  <tr key={e.id} className="hover:bg-slate-50 cursor-pointer group">
                    <td className="px-4 py-2">
                      <Link href={planHref} className="block">
                        <div className="text-slate-900 group-hover:text-blue-700 inline-flex items-center gap-1.5">
                          {e.family_label}
                          {e.tuition_override_cents === 0 ? (
                            <span className="rounded-full bg-emerald-100 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-emerald-800" title="Scholarship — family owes $0">
                              🎓 Scholarship
                            </span>
                          ) : e.tuition_override_cents != null ? (
                            <span className="rounded-full bg-blue-100 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wide text-blue-800" title="Custom tuition set by operator">
                              ✏️ Custom
                            </span>
                          ) : null}
                        </div>
                        {e.student_label ? <div className="text-[11px] text-slate-500">{e.student_label}</div> : null}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <Link href={planHref} className="block">
                        <div className="text-slate-900">{e.grid_label}</div>
                        <div className="text-[11px] text-slate-500">{e.plan_label}</div>
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono">
                      <Link href={planHref} className="block">{e.academic_year}</Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      <Link href={planHref} className="block">${(e.total_annual_cents / 100).toFixed(2)}</Link>
                    </td>
                    <td className="px-4 py-2">
                      <Link href={planHref} className="block">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden min-w-[80px]">
                            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] text-slate-600 tabular-nums whitespace-nowrap">
                            {e.invoices_paid}/{e.invoices_paid + e.invoices_open}
                          </span>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <Link href={planHref} className="block"><StatusPill status={e.status} /></Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {void locationId}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Plan template UI

function EmptyTemplatesPanel({ apiBase, returnTo }: { apiBase: string; returnTo: string }) {
  return (
    <div className="rounded-lg border-2 border-dashed border-slate-300 bg-white p-8 text-center">
      <Sparkles className="mx-auto h-8 w-8 text-amber-400" />
      <p className="mt-3 text-sm font-semibold text-slate-700">No payment plan templates yet</p>
      <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
        We can seed four common ones — Annual, Semi-annual, Quarterly, Monthly × 10 — so you can start enrolling families right away. You can edit or remove any of them after.
      </p>
      <form action={apiBase} method="POST" className="mt-4 inline-block">
        <input type="hidden" name="op" value="seed_defaults" />
        <input type="hidden" name="return_to" value={returnTo} />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Sparkles className="h-4 w-4" /> Seed 4 default plans
        </button>
      </form>
      <p className="mt-2 text-[11px] text-slate-400">…or scroll down and build your own.</p>
    </div>
  );
}

function PlanTemplateRow({
  template, apiBase, returnTo, locationId, isEditing,
}: {
  template: PlanTemplateRow;
  apiBase: string;
  returnTo: string;
  locationId: string;
  isEditing: boolean;
}) {
  const editHref = `/school/${locationId}/payments?tab=plans&edit_template=${template.id}`;
  const cancelHref = `/school/${locationId}/payments?tab=plans`;

  if (isEditing) {
    return (
      <tr className="bg-blue-50/40">
        <td colSpan={8} className="p-0">
          <form action={apiBase} method="POST" className="px-4 py-4 space-y-3">
            <input type="hidden" name="op" value="update" />
            <input type="hidden" name="id" value={template.id} />
            <input type="hidden" name="return_to" value={returnTo} />

            <div className="flex items-center gap-2 mb-2">
              <Pencil className="h-4 w-4 text-blue-700" />
              <span className="text-sm font-semibold text-blue-900">Editing: {template.display_name}</span>
              <span className="text-[11px] text-blue-700 font-mono ml-1">{template.slug}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-start">
              <Field className="sm:col-span-4" label="Display name" hint="Shown to parents in the plan picker.">
                <input type="text" name="display_name" defaultValue={template.display_name} required className={inputCls} />
              </Field>
              <Field className="sm:col-span-2" label="Installments" hint="1, 2, 4, 10, 12 fill schedules automatically.">
                <input type="number" name="installment_count" min="1" max="36" defaultValue={template.installment_count} required className={inputCls + ' text-right'} />
              </Field>
              <Field className="sm:col-span-3" label="First payment due (optional)" hint="Anchor for the first installment. Year is auto-derived from each family's academic year — pick any year, only month + day matter.">
                <input
                  type="date"
                  name="first_due_month_day"
                  defaultValue={template.first_due_month_day ? `2026-${template.first_due_month_day}` : ''}
                  className={inputCls}
                />
              </Field>
              <Field className="sm:col-span-3" label="Prompt-pay discount %" hint="Discount applied if this plan is chosen.">
                <div className="flex items-center gap-1">
                  <input type="number" step="0.1" min="0" max="50" name="discount_pct" defaultValue={(template.discount_basis_points / 100).toFixed(1)} className={inputCls + ' text-right'} />
                  <span className="text-sm text-slate-500">%</span>
                </div>
              </Field>
              <Field className="sm:col-span-6" label="Active" hint="Inactive templates are hidden from new enrollments.">
                <label className="flex items-center gap-2 text-sm pt-2">
                  <input type="checkbox" name="is_active" value="1" defaultChecked={template.is_active} className="h-4 w-4 rounded border-slate-300" />
                  <span>Available for new enrollments</span>
                </label>
              </Field>
              <Field className="sm:col-span-12" label="Description (optional)" hint="A one-liner shown to parents.">
                <input type="text" name="description" defaultValue={template.description ?? ''} placeholder='e.g. "Equal monthly payments August through May"' className={inputCls} />
              </Field>
            </div>

            {template.in_use_count > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <strong>{template.in_use_count}</strong> family enrollment{template.in_use_count === 1 ? '' : 's'} use this template.
                Changing the installment count or discount won&rsquo;t retroactively reshuffle their existing invoices —
                only NEW enrollments will use the updated schedule. To adjust an existing family&rsquo;s plan, click their
                row in the Family enrollments table below.
              </div>
            ) : null}

            <div className="flex items-center justify-between border-t border-blue-100 pt-3">
              <DeactivateButton
                apiBase={apiBase}
                returnTo={returnTo}
                templateId={template.id}
                templateName={template.display_name}
                inUse={template.in_use_count > 0}
                isActive={template.is_active}
              />
              <div className="flex gap-2">
                <Link href={cancelHref} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                  <X className="h-3.5 w-3.5" /> Cancel
                </Link>
                <button type="submit" className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
                  Save changes
                </button>
              </div>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  // Read-only row
  return (
    <tr className={template.is_active ? 'hover:bg-slate-50' : 'opacity-60 hover:bg-slate-50'}>
      <td className="px-3 py-2.5">
        <div className="font-medium text-slate-900">{template.display_name}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{template.slug}</div>
      </td>
      <td className="px-3 py-2.5 text-xs text-slate-600">
        {template.description ? template.description : <span className="italic text-slate-400">— none —</span>}
      </td>
      <td className="px-3 py-2.5 text-center tabular-nums text-sm text-slate-700">
        {template.installment_count}
      </td>
      <td className="px-3 py-2.5 text-center text-sm text-slate-700 whitespace-nowrap">
        {template.first_due_month_day
          ? formatMonthDay(template.first_due_month_day)
          : <span className="text-slate-400 italic text-xs">default</span>}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm text-slate-700">
        {template.discount_basis_points > 0
          ? `${(template.discount_basis_points / 100).toFixed(1)}%`
          : <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2.5 text-center tabular-nums text-xs">
        {template.in_use_count > 0 ? (
          <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-blue-800 font-semibold">
            {template.in_use_count}
          </span>
        ) : (
          <span className="text-slate-400">0</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center">
        {template.is_active ? (
          <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
            Active
          </span>
        ) : (
          <span className="inline-block rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
            Inactive
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        <Link
          href={editHref}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700"
        >
          <Edit3 className="h-3 w-3" /> Edit
        </Link>
      </td>
    </tr>
  );
}

function DeactivateButton({
  apiBase, returnTo, templateId, templateName, inUse, isActive,
}: {
  apiBase: string; returnTo: string;
  templateId: string; templateName: string; inUse: boolean; isActive: boolean;
}) {
  if (!isActive) {
    return <span className="text-[11px] text-slate-400 italic">Inactive — uncheck above + Save to reactivate</span>;
  }
  return (
    <form action={apiBase} method="POST">
      <input type="hidden" name="op" value="delete" />
      <input type="hidden" name="id" value={templateId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <button
        type="submit"
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300"
        title={inUse
          ? `${templateName} is in use by enrolled families — deactivating hides it from future enrollments without affecting existing ones.`
          : `Deactivate "${templateName}" — it stops appearing in new enrollment flows but is preserved for history.`}
      >
        <Trash2 className="h-3 w-3" /> Deactivate
      </button>
    </form>
  );
}

function AddTemplateForm({ apiBase, returnTo }: { apiBase: string; returnTo: string }) {
  return (
    <details className="mt-3 rounded-lg border border-blue-200 bg-blue-50/40 group">
      <summary className="cursor-pointer list-none px-4 py-2.5 flex items-center gap-2 text-sm font-medium text-blue-800 hover:bg-blue-50">
        <Plus className="h-4 w-4" />
        Add a new payment plan template
        <span className="text-[11px] font-normal text-blue-700 ml-1">— quarterly, custom installments, etc.</span>
      </summary>
      <form action={apiBase} method="POST" className="px-4 py-3 border-t border-blue-100 bg-white space-y-3">
        <input type="hidden" name="op" value="add" />
        <input type="hidden" name="return_to" value={returnTo} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Display name" hint='What families see — e.g. "10 Monthly Payments"'>
            <input
              type="text" name="display_name" required
              placeholder="10 Monthly Payments"
              className={inputCls}
            />
          </Field>
          <Field label="Slug" hint="Lowercase, hyphens. Used internally for API references.">
            <input
              type="text" name="slug" required
              pattern="[a-z0-9\-]+"
              placeholder="monthly-10"
              className={inputCls + ' font-mono'}
            />
          </Field>
          <Field label="Number of installments" hint="1 = annual, 2 = semi-annual, 4 = quarterly, 10 = Aug–May, 12 = full year.">
            <input
              type="number" name="installment_count" required min="1" max="36" defaultValue="10"
              className={inputCls + ' w-32'}
            />
          </Field>
          <Field label="Prompt-pay discount %" hint="Applied if a family chooses this plan. Leave 0 for no discount.">
            <div className="flex items-center gap-1">
              <input
                type="number" name="discount_pct" step="0.1" min="0" max="50" defaultValue="0"
                className={inputCls + ' w-24 text-right'}
              />
              <span className="text-sm text-slate-500">%</span>
            </div>
          </Field>
        </div>

        <Field label="First payment due (optional)" hint="Anchor for the first installment. Year is auto-derived from each family's academic year — pick any year, only the month + day matter. Leave blank to default to the 1st of each month (or Aug 15 for single annual).">
          <input
            type="date"
            name="first_due_month_day"
            placeholder="e.g. Aug 1"
            className={inputCls}
          />
        </Field>

        <Field label="Description (optional)" hint="A one-liner shown to parents in the plan picker.">
          <input
            type="text" name="description"
            placeholder='e.g. "Equal payments due the 1st of each month, August through May."'
            className={inputCls}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" /> Create plan template
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          The installment schedule is filled in automatically based on the count you pick (e.g. 10 → Aug through May).
          You can fine-tune the schedule later via the operator console if you need custom due dates.
        </p>
      </form>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div> : null}
    </label>
  );
}

const inputCls =
  'block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200';

// "08-01" → "Aug 1"
function formatMonthDay(md: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(md);
  if (!m) return md;
  const monthIdx = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (monthIdx < 0 || monthIdx > 11) return md;
  return `${monthNames[monthIdx]} ${day}`;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    active:    { bg: 'bg-emerald-100', fg: 'text-emerald-800' },
    paused:    { bg: 'bg-amber-100',   fg: 'text-amber-800' },
    completed: { bg: 'bg-blue-100',    fg: 'text-blue-800' },
    cancelled: { bg: 'bg-slate-100',   fg: 'text-slate-600' },
  };
  const cfg = map[status] ?? { bg: 'bg-slate-100', fg: 'text-slate-600' };
  return <span className={`rounded-full ${cfg.bg} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.fg}`}>{status}</span>;
}
