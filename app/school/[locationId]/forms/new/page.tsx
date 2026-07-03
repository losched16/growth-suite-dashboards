// /school/[locationId]/forms/new — create a new portal form from inside
// the GHL iframe. Mirrors /admin/[schoolId]/forms/new but stays within
// the school context (school session, school-namespaced URLs).
//
// Reached from the Payments hub → Forms tab → "+ Create new form" button.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { query } from '@/lib/db';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { FORM_TEMPLATES } from '@/lib/forms/templates';
import { NewFormForm } from './NewFormForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ chrome?: string }>;

export default async function NewSchoolFormPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  await searchParams; // consumed; chrome is handled by proxy
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
            Start from a template, or build one from scratch below.
          </p>
        </header>

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
