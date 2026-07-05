// /school/[locationId]/forms/new — create a new portal form from inside
// the GHL iframe. Mirrors /admin/[schoolId]/forms/new but stays within
// the school context (school session, school-namespaced URLs).
//
// Reached from the Payments hub → Forms tab → "+ Create new form" button.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FilePlus2, Upload, Sparkles } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FORM_TEMPLATES } from '@/lib/forms/templates';
import { NewFormForm } from './NewFormForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ chrome?: string; err?: string }>;

export default async function NewSchoolFormPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const sp = await searchParams; // chrome handled by proxy
  const err = typeof sp.err === 'string' ? sp.err : null;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();

  // Pull existing slugs so the wizard can client-side validate duplicates.
  const { rows: existingSlugs } = await query<{ slug: string }>(
    `SELECT slug FROM portal_form_definitions
      WHERE school_id = $1 AND COALESCE(audience, 'parents') = 'parents'`,
    [school.id],
  );

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-2xl space-y-4">
        <Link
          href={`/school/${locationId}/forms`}
          className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Forms
        </Link>
        <header>
          <h1 className="text-2xl font-semibold text-zinc-900">Create a new form</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Import a form you already have, start from a template, or build one from scratch.
          </p>
        </header>

        {err ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
        ) : null}

        {/* Import an existing form — AI drafts the fields, you refine + publish. */}
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
            <Sparkles className="h-4 w-4 text-emerald-700" /> Import a form you already have
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Upload a PDF or paste a Google Form link. We&rsquo;ll draft the fields for you — then you
            review the field types, dropdown options, and logic in the builder and publish. Creates a
            draft; parents see nothing until you publish.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* PDF upload */}
            <form action={`/api/school/${locationId}/forms/import`} method="POST" encType="multipart/form-data"
              className="rounded-lg border border-zinc-200 bg-white p-3">
              <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-800">
                <Upload className="h-3.5 w-3.5 text-emerald-700" /> Upload a PDF
              </label>
              <input type="file" name="pdf" accept="application/pdf" required
                className="mt-2 block w-full text-[11px] text-zinc-600 file:mr-2 file:rounded file:border-0 file:bg-emerald-600 file:px-2 file:py-1 file:text-[11px] file:font-medium file:text-white hover:file:bg-emerald-700" />
              <button type="submit" className="mt-3 w-full rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                Import PDF →
              </button>
              <p className="mt-1 text-[10px] text-zinc-400">Takes ~30s. Max 12 MB.</p>
            </form>
            {/* Google Form link */}
            <form action={`/api/school/${locationId}/forms/import`} method="POST"
              className="rounded-lg border border-zinc-200 bg-white p-3">
              <label className="text-xs font-medium text-zinc-800">Paste a Google Form link</label>
              <input type="url" name="google_url" placeholder="https://docs.google.com/forms/…" required
                className="mt-2 block w-full rounded border border-zinc-300 px-2 py-1.5 text-[11px] focus:border-emerald-500 focus:outline-none" />
              <button type="submit" className="mt-3 w-full rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                Import from Google Form →
              </button>
              <p className="mt-1 text-[10px] text-zinc-400">The form must be shared publicly (anyone with the link).</p>
            </form>
          </div>
          <p className="mt-2 text-[10px] text-zinc-400">
            Using JotForm, Typeform, or another tool? Save/print it to PDF and upload that — it becomes a real,
            editable Growth Suite form so submissions flow into your contact records.
          </p>
        </section>

        {/* Starter templates — each creates a DRAFT and opens the builder.
            Generic content: the school edits the placeholder text, sets who
            sees it, then publishes. */}
        <section className="rounded-xl border border-black/10 bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-900">Start from a template</h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Creates a draft — parents can&rsquo;t see it until you publish. Edit everything in the builder first.
          </p>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FORM_TEMPLATES.map((t) => (
              <form key={t.key} action={`/api/school/${locationId}/forms/from-template`} method="POST">
                <input type="hidden" name="template" value={t.key} />
                <button
                  type="submit"
                  className="w-full rounded-lg border border-zinc-200 bg-white p-3 text-left hover:border-emerald-300 hover:bg-emerald-50/40"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                    <FilePlus2 className="h-3.5 w-3.5 text-emerald-700" /> {t.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-zinc-500">{t.description}</span>
                </button>
              </form>
            ))}
          </div>
        </section>

        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Or from scratch</div>
        <NewFormForm
          locationId={locationId}
          existingSlugs={existingSlugs.map((s) => s.slug)}
        />
      </div>
    </main>
  );
}
