// Catalog loader for the invoice-creation flow. Pulls the active
// products + tuition grids for a school and shapes them into the
// CatalogItem format that the LineItemsEditor expects.
//
// Used by both the operator and the school-side "new invoice" pages
// so the dropdown stays consistent.

import { query } from '@/lib/db';
import type { CatalogItem } from '@/app/admin/[schoolId]/payments/invoices/new/LineItemsEditor';

export async function loadInvoiceCatalog(schoolId: string): Promise<CatalogItem[]> {
  const [{ rows: grids }, { rows: products }] = await Promise.all([
    query<{
      id: string;
      display_name: string;
      program: string;
      grade_level: string | null;
      academic_year: string;
      annual_tuition_cents: number;
    }>(
      `SELECT id, display_name, program, grade_level, academic_year, annual_tuition_cents
         FROM tuition_grids
        WHERE school_id = $1 AND is_active = true
        ORDER BY academic_year DESC, position ASC, program`,
      [schoolId],
    ),
    query<{
      id: string;
      name: string;
      product_type: 'one_time' | 'recurring' | 'donation';
      price_cents: number | null;
      recurring_interval: 'month' | 'year' | null;
    }>(
      `SELECT id, name, product_type, price_cents, recurring_interval
         FROM school_products
        WHERE school_id = $1 AND is_active = true
        ORDER BY position ASC, created_at ASC`,
      [schoolId],
    ),
  ]);

  const items: CatalogItem[] = [];

  for (const g of grids) {
    const yearTag = g.academic_year ? ` · ${g.academic_year}` : '';
    items.push({
      id: `grid:${g.id}`,
      group: 'tuition',
      label: `${g.display_name} — $${(g.annual_tuition_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr${yearTag}`,
      description: `${g.display_name} (${g.academic_year}) — full-year tuition`,
      unit_amount_cents: g.annual_tuition_cents,
      category: 'tuition',
      hint: 'Adds the full annual tuition as one line. Edit the amount or quantity below if you only want to charge a portion (e.g. one month of a 10-month plan).',
    });
  }

  for (const p of products) {
    if (p.product_type === 'donation') {
      // Donations are pay-what-you-want — we still surface them in the
      // picker so staff can add a line and type whatever amount, but
      // we seed unit_amount with 0 so they're forced to fill it in.
      items.push({
        id: `product:${p.id}`,
        group: 'product',
        label: `${p.name} (donation — any amount)`,
        description: p.name,
        unit_amount_cents: 0,
        category: 'fee',
        hint: 'Donation product — set the dollar amount below.',
      });
      continue;
    }
    const amt = p.price_cents ?? 0;
    const intervalSuffix = p.product_type === 'recurring' && p.recurring_interval
      ? `/${p.recurring_interval}`
      : '';
    items.push({
      id: `product:${p.id}`,
      group: 'product',
      label: `${p.name} — $${(amt / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${intervalSuffix}`,
      description: p.name,
      unit_amount_cents: amt,
      category: p.product_type === 'recurring' ? 'subscription' : 'fee',
      hint: p.product_type === 'recurring'
        ? 'Recurring product. Adding it here creates a one-off invoice line — for true recurring billing, send the parent the product link instead.'
        : undefined,
    });
  }

  // Always include the standard family setup fee + late fee as
  // quick-add convenience options.
  items.push({
    id: 'fee:setup',
    group: 'fee',
    label: 'Family setup fee — $25.00',
    description: 'Family setup fee',
    unit_amount_cents: 2500,
    category: 'fee',
    hint: 'One-time platform setup fee. The form below has a dedicated checkbox for this — use that instead if you want it tracked as the family-level setup fee.',
  });
  items.push({
    id: 'fee:late',
    group: 'fee',
    label: 'Late fee — $25.00',
    description: 'Late fee',
    unit_amount_cents: 2500,
    category: 'fee',
  });

  return items;
}
