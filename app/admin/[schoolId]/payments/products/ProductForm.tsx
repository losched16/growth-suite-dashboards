'use client';

// Reusable product create/edit form. Same component drives both
// `/products/new` and `/products/[id]` — when given a `product` prop,
// it pre-fills + POSTs as an edit; without one, it creates new.
//
// Form-state pattern: uncontrolled inputs with `defaultValue`, with one
// piece of React state for `productType` so we can show/hide the
// type-specific sub-forms (price vs suggested amounts vs recurring).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Save, AlertCircle, Loader2 } from 'lucide-react';

type ProductType = 'one_time' | 'recurring' | 'donation';

interface Product {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  product_type: ProductType;
  price_cents: number | null;
  suggested_amounts_cents: number[] | null;
  donation_min_cents: number | null;
  recurring_interval: 'month' | 'year' | null;
  recurring_installment_count: number | null;
  recurring_first_charge_date: string | null;
  per_student: boolean;
  max_quantity: number | null;
  available_to: 'parents' | 'public' | 'both';
  available_from: string | null;
  available_until: string | null;
  image_url: string | null;
  ghl_writeback_field: string | null;
  is_active: boolean;
  internal_note: string | null;
}

export function ProductForm({
  schoolId,
  product,
}: {
  schoolId: string;
  product?: Product;
}) {
  const router = useRouter();
  const isEdit = !!product;
  const [productType, setProductType] = useState<ProductType>(product?.product_type ?? 'one_time');
  const [err, setErr] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    const fd = new FormData(e.currentTarget);
    // Parse suggested amounts: comma-separated dollar values → cents array
    const suggestedRaw = String(fd.get('suggested_amounts') ?? '').trim();
    const suggested_amounts_cents = suggestedRaw
      ? suggestedRaw
          .split(',')
          .map((s) => Math.round(parseFloat(s.trim()) * 100))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];

    const payload: Record<string, unknown> = {
      slug: String(fd.get('slug') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
      description: String(fd.get('description') ?? '').trim() || null,
      category: String(fd.get('category') ?? '').trim() || null,
      product_type: productType,
      per_student: fd.get('per_student') === '1',
      available_to: String(fd.get('available_to') ?? 'both'),
      is_active: fd.get('is_active') === '1',
      image_url: String(fd.get('image_url') ?? '').trim() || null,
      ghl_writeback_field: String(fd.get('ghl_writeback_field') ?? '').trim() || null,
      internal_note: String(fd.get('internal_note') ?? '').trim() || null,
      max_quantity: fd.get('max_quantity') ? Number(fd.get('max_quantity')) : null,
      available_from: String(fd.get('available_from') ?? '').trim() || null,
      available_until: String(fd.get('available_until') ?? '').trim() || null,
    };

    // Type-specific
    if (productType === 'one_time') {
      const price = parseFloat(String(fd.get('price') ?? ''));
      if (!Number.isFinite(price) || price <= 0) {
        setErr('Price must be a positive number for one-time products.');
        return;
      }
      payload.price_cents = Math.round(price * 100);
    } else if (productType === 'recurring') {
      const price = parseFloat(String(fd.get('price') ?? ''));
      if (!Number.isFinite(price) || price <= 0) {
        setErr('Price per period must be a positive number for recurring products.');
        return;
      }
      payload.price_cents = Math.round(price * 100);
      payload.recurring_interval = String(fd.get('recurring_interval') ?? 'month');
      const count = fd.get('recurring_installment_count');
      payload.recurring_installment_count = count ? Number(count) : null;
      payload.recurring_first_charge_date = String(fd.get('recurring_first_charge_date') ?? '').trim() || null;
    } else if (productType === 'donation') {
      payload.suggested_amounts_cents = suggested_amounts_cents;
      const minDollars = parseFloat(String(fd.get('donation_min') ?? ''));
      payload.donation_min_cents = Number.isFinite(minDollars) && minDollars > 0
        ? Math.round(minDollars * 100)
        : 100; // default $1 min if unspecified
    }

    startTransition(async () => {
      const url = isEdit
        ? `/api/admin/schools/${schoolId}/products/${product!.id}`
        : `/api/admin/schools/${schoolId}/products`;
      const method = isEdit ? 'PATCH' : 'POST';
      try {
        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { error?: string; detail?: string }).detail || (body as { error?: string }).error || `HTTP ${r.status}`);
        }
        const body = await r.json();
        const id = (body as { id?: string }).id ?? product?.id;
        router.push(`/admin/${schoolId}/payments/products?msg=${encodeURIComponent(isEdit ? 'Product updated' : 'Product created')}`);
        router.refresh();
        void id;
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Save failed.');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 max-w-3xl">
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          {err}
        </div>
      ) : null}

      {/* ─── Basics ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Basics</h2>

        <Field label="Product name" required>
          <input
            type="text"
            name="name"
            required
            defaultValue={product?.name ?? ''}
            placeholder="e.g. Spring Fundraiser Ticket"
            className={inputCls}
          />
        </Field>

        <Field label="URL slug" required hint="Lowercase letters, numbers, and hyphens. Becomes part of the public payment link.">
          <input
            type="text"
            name="slug"
            required
            pattern="[a-z0-9-]+"
            defaultValue={product?.slug ?? ''}
            placeholder="e.g. spring-fundraiser"
            className={inputCls + ' font-mono'}
          />
        </Field>

        <Field label="Description (optional)">
          <textarea
            name="description"
            rows={3}
            defaultValue={product?.description ?? ''}
            placeholder="What is this? What does the buyer get?"
            className={inputCls}
          />
        </Field>

        <Field label="Category (optional)" hint="Helps your team filter and report. Examples: event, donation, supplies, after-school, tuition_addon.">
          <input
            type="text"
            name="category"
            defaultValue={product?.category ?? ''}
            className={inputCls}
          />
        </Field>
      </section>

      {/* ─── Type ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Type</h2>
        <div className="grid grid-cols-3 gap-2">
          {(['one_time', 'recurring', 'donation'] as const).map((t) => (
            <label
              key={t}
              className={`cursor-pointer rounded-md border-2 px-3 py-2 text-sm ${
                productType === t ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <input
                type="radio"
                name="product_type"
                value={t}
                checked={productType === t}
                onChange={() => setProductType(t)}
                className="sr-only"
              />
              <div className="font-medium text-gray-900">
                {t === 'one_time' ? 'One-time' : t === 'recurring' ? 'Recurring' : 'Donation'}
              </div>
              <div className="text-[11px] text-gray-600 mt-0.5">
                {t === 'one_time' && 'Fixed price, single charge'}
                {t === 'recurring' && 'Stripe subscription (monthly/yearly)'}
                {t === 'donation' && 'Variable amount with optional suggestions'}
              </div>
            </label>
          ))}
        </div>
      </section>

      {/* ─── Pricing (varies by type) ────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Pricing</h2>

        {productType === 'one_time' ? (
          <Field label="Price (USD)" required>
            <div className="flex items-center gap-1">
              <span className="text-gray-500">$</span>
              <input
                type="number"
                name="price"
                step="0.01"
                min="0.50"
                required
                defaultValue={product?.price_cents ? (product.price_cents / 100).toFixed(2) : ''}
                className={inputCls + ' max-w-[10rem]'}
              />
            </div>
          </Field>
        ) : null}

        {productType === 'recurring' ? (
          <>
            <Field label="Price per period (USD)" required>
              <div className="flex items-center gap-1">
                <span className="text-gray-500">$</span>
                <input
                  type="number"
                  name="price"
                  step="0.01"
                  min="0.50"
                  required
                  defaultValue={product?.price_cents ? (product.price_cents / 100).toFixed(2) : ''}
                  className={inputCls + ' max-w-[10rem]'}
                />
              </div>
            </Field>
            <Field label="Billing interval" required>
              <select
                name="recurring_interval"
                defaultValue={product?.recurring_interval ?? 'month'}
                className={inputCls + ' max-w-[14rem]'}
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </Field>
            <Field label="Number of installments (optional)" hint="Leave blank for ongoing. E.g. 10 = bill 10 months then stop.">
              <input
                type="number"
                name="recurring_installment_count"
                min="1"
                max="120"
                defaultValue={product?.recurring_installment_count ?? ''}
                placeholder="(forever)"
                className={inputCls + ' max-w-[10rem]'}
              />
            </Field>
            <Field label="First charge date (optional)" hint="Defaults to immediately on purchase.">
              <input
                type="date"
                name="recurring_first_charge_date"
                defaultValue={product?.recurring_first_charge_date ?? ''}
                className={inputCls + ' max-w-[14rem]'}
              />
            </Field>
          </>
        ) : null}

        {productType === 'donation' ? (
          <>
            <Field
              label="Suggested amounts (USD, comma-separated)"
              hint="Donor picks one or enters their own. Example: 25, 50, 100, 250"
            >
              <input
                type="text"
                name="suggested_amounts"
                defaultValue={
                  product?.suggested_amounts_cents
                    ? product.suggested_amounts_cents.map((c) => (c / 100).toFixed(0)).join(', ')
                    : ''
                }
                placeholder="25, 50, 100, 250"
                className={inputCls + ' max-w-[24rem]'}
              />
            </Field>
            <Field label="Minimum donation (USD)" hint="Lowest amount a donor can give. Default $1.">
              <div className="flex items-center gap-1">
                <span className="text-gray-500">$</span>
                <input
                  type="number"
                  name="donation_min"
                  step="0.01"
                  min="1"
                  defaultValue={product?.donation_min_cents ? (product.donation_min_cents / 100).toFixed(2) : '1.00'}
                  className={inputCls + ' max-w-[10rem]'}
                />
              </div>
            </Field>
          </>
        ) : null}
      </section>

      {/* ─── Availability ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Availability</h2>

        <Field label="Who can buy this?" required>
          <select
            name="available_to"
            defaultValue={product?.available_to ?? 'both'}
            className={inputCls + ' max-w-[20rem]'}
          >
            <option value="both">Both parents (logged in) and public (via shared link)</option>
            <option value="parents">Parents only (must be logged into portal)</option>
            <option value="public">Public only (shared link, no portal login)</option>
          </select>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Available from (optional)">
            <input
              type="datetime-local"
              name="available_from"
              defaultValue={product?.available_from?.slice(0, 16) ?? ''}
              className={inputCls}
            />
          </Field>
          <Field label="Available until (optional)">
            <input
              type="datetime-local"
              name="available_until"
              defaultValue={product?.available_until?.slice(0, 16) ?? ''}
              className={inputCls}
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            name="per_student"
            value="1"
            defaultChecked={product?.per_student ?? false}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span>
            <span className="font-medium text-gray-900">Per-student product</span>
            <span className="block text-[11px] text-gray-600 mt-0.5">
              Buyer picks which student this applies to. Use for things like
              &ldquo;field trip permission&rdquo; or &ldquo;after-school activity for Charlie.&rdquo;
            </span>
          </span>
        </label>

        <Field label="Max quantity per purchase (optional)">
          <input
            type="number"
            name="max_quantity"
            min="1"
            max="999"
            defaultValue={product?.max_quantity ?? ''}
            placeholder="(unlimited)"
            className={inputCls + ' max-w-[10rem]'}
          />
        </Field>
      </section>

      {/* ─── Advanced ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Advanced (optional)</h2>

        <Field label="Image URL" hint="Shown on the public payment page. Use a square image, ideally 600×600.">
          <input
            type="url"
            name="image_url"
            defaultValue={product?.image_url ?? ''}
            placeholder="https://..."
            className={inputCls}
          />
        </Field>

        <Field label="GHL custom field to flag on purchase" hint="Optional. We'll set this field to the date of purchase on the contact's GHL record.">
          <input
            type="text"
            name="ghl_writeback_field"
            defaultValue={product?.ghl_writeback_field ?? ''}
            placeholder="e.g. purchased_spring_fundraiser"
            className={inputCls + ' font-mono text-xs'}
          />
        </Field>

        <Field label="Internal notes" hint="Visible only to operators. Not shown to buyers.">
          <textarea
            name="internal_note"
            rows={2}
            defaultValue={product?.internal_note ?? ''}
            className={inputCls}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            name="is_active"
            value="1"
            defaultChecked={product?.is_active ?? true}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span>
            <span className="font-medium text-gray-900">Active</span>
            <span className="block text-[11px] text-gray-600 mt-0.5">
              Inactive products are hidden from buyers but kept in your records.
            </span>
          </span>
        </label>
      </section>

      {/* ─── Actions ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isEdit ? 'Save changes' : 'Create product'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/admin/${schoolId}/payments/products`)}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200';

function Field({
  label, required, hint, children,
}: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </span>
      {hint ? <span className="block text-[11px] text-gray-500 mt-0.5">{hint}</span> : null}
      {children}
    </label>
  );
}
