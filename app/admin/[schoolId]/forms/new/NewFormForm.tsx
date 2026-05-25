'use client';

// Create-form wizard. Operator picks essentials + optional starter
// template. Three templates: blank, parent-info, signature-only.
// Each pre-populates field_schema so the editor starts non-empty.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Save, AlertCircle, Loader2, FileText, PenTool, FileCheck2 } from 'lucide-react';

type Template = 'blank' | 'parent_info' | 'signature_only' | 'health';

const TEMPLATE_DESCRIPTIONS: Record<Template, string> = {
  blank: 'Just a header + signature. Add everything else in the editor.',
  parent_info: 'Header + parent name/email/phone fields + signature.',
  signature_only: 'Just an acknowledgement paragraph + signature line.',
  health: 'Allergies, medications, emergency contact, signature.',
};

const TEMPLATE_ICONS: Record<Template, typeof FileText> = {
  blank: FileText,
  parent_info: FileText,
  signature_only: PenTool,
  health: FileCheck2,
};

export function NewFormForm({
  schoolId, existingSlugs,
}: {
  schoolId: string;
  existingSlugs: string[];
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template>('blank');
  const [autoSlug, setAutoSlug] = useState<boolean>(true);
  const [slug, setSlug] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');

  function slugify(text: string): string {
    return text.trim().toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60);
  }

  function onNameChange(v: string) {
    setDisplayName(v);
    if (autoSlug) setSlug(slugify(v));
  }

  const slugCollision = !!slug && existingSlugs.includes(slug);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    if (!displayName.trim()) { setErr('Display name is required.'); return; }
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      setErr('Slug must be lowercase letters, numbers, and hyphens.');
      return;
    }
    if (slugCollision) {
      setErr('That slug already exists for this school. Pick another.');
      return;
    }

    const fd = new FormData(e.currentTarget);
    const payload = {
      slug,
      display_name: displayName.trim(),
      description: String(fd.get('description') ?? '').trim() || null,
      category: String(fd.get('category') ?? '').trim() || null,
      per_student: fd.get('per_student') === '1',
      template,
    };

    startTransition(async () => {
      try {
        const r = await fetch(`/api/admin/schools/${schoolId}/forms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error((body as { detail?: string }).detail || (body as { error?: string }).error || `HTTP ${r.status}`);
        }
        const body = await r.json() as { id?: string };
        // Land on the editor for the new form
        router.push(`/admin/${schoolId}/forms/${body.id}`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Could not create form.');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-xl border border-black/10 bg-white p-5">
      {err ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {err}
        </div>
      ) : null}

      {/* Basics */}
      <Field label="Display name" required hint="What parents will see in the portal.">
        <input
          type="text"
          value={displayName}
          onChange={(e) => onNameChange(e.target.value)}
          required
          placeholder="e.g. Field Trip Permission"
          className={inputCls}
        />
      </Field>

      <Field label="URL slug" required hint="Used in the form URL. Auto-filled from the name above.">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={slug}
            onChange={(e) => { setAutoSlug(false); setSlug(e.target.value); }}
            required
            pattern="[a-z0-9-]+"
            placeholder="e.g. field-trip-permission"
            className={inputCls + ' font-mono'}
          />
          {!autoSlug ? (
            <button
              type="button"
              onClick={() => { setAutoSlug(true); setSlug(slugify(displayName)); }}
              className="text-[11px] text-zinc-500 hover:underline whitespace-nowrap"
            >
              auto-fill
            </button>
          ) : null}
        </div>
        {slugCollision ? (
          <p className="mt-1 text-xs text-rose-700">A form with this slug already exists for this school.</p>
        ) : null}
      </Field>

      <Field label="Description (optional)" hint="One-liner shown under the form title in the portal.">
        <textarea
          name="description"
          rows={2}
          placeholder="Brief description of what this form is for."
          className={inputCls}
        />
      </Field>

      <Field label="Category (optional)" hint="Helps organize the forms list. Examples: medical, legal, release, enrollment.">
        <input type="text" name="category" placeholder="e.g. medical" className={inputCls} />
      </Field>

      {/* Per-student */}
      <label className="flex items-start gap-2 cursor-pointer rounded-md border border-zinc-200 bg-zinc-50/40 px-3 py-2">
        <input type="checkbox" name="per_student" value="1" className="mt-0.5 h-4 w-4" />
        <span>
          <span className="text-sm font-medium text-zinc-900">Ask once per student</span>
          <span className="block text-[11px] text-zinc-600 mt-0.5">
            When ON, parents fill the form separately for each child in the family.
            When OFF, the form is family-level (one submission covers all kids).
          </span>
        </span>
      </label>

      {/* Template picker */}
      <div>
        <div className="text-sm font-medium text-zinc-900 mb-2">Starter template</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(Object.keys(TEMPLATE_DESCRIPTIONS) as Template[]).map((t) => {
            const Icon = TEMPLATE_ICONS[t];
            const selected = template === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTemplate(t)}
                className={`text-left rounded-md border-2 p-3 ${
                  selected ? 'border-emerald-600 bg-emerald-50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-zinc-500" />
                  <span className="text-sm font-semibold text-zinc-900 capitalize">
                    {t.replace('_', ' ')}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-zinc-600">
                  {TEMPLATE_DESCRIPTIONS[t]}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-zinc-100 pt-4">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Create form
        </button>
        <p className="text-[11px] text-zinc-500">After creating, you&rsquo;ll land on the editor to add or adjust fields.</p>
      </div>
    </form>
  );
}

const inputCls =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200';

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-900">
        {label} {required ? <span className="text-rose-600">*</span> : null}
      </span>
      {hint ? <span className="block text-[11px] text-zinc-500 mt-0.5">{hint}</span> : null}
      {children}
    </label>
  );
}
