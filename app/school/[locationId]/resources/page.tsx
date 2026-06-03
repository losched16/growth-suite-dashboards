// /school/[locationId]/resources
//
// Operator UI for managing the parent-portal /resources section —
// upload, rename, recategorize, delete documents that every family
// at the school sees (supply lists, calendar, parent handbook, etc.).
// File payload is bytea on school_documents; see migration 049.
//
// Layout: success / error banners up top, "Upload new" form, then a
// grouped list of existing docs. Each row inline-edits via a small
// form so the operator never leaves the page.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { BookOpen, ExternalLink, Upload, FileText } from 'lucide-react';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';
import { DeleteResourceButton } from './DeleteResourceButton';

export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<{ msg?: string; err?: string }>;

interface Row {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

export default async function SchoolResourcesPage({
  params, searchParams,
}: { params: Params; searchParams: SearchParams }) {
  const { locationId } = await params;
  const { msg, err } = await searchParams;

  const school = await loadSchoolByLocationId(locationId);
  if (!school) notFound();
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) notFound();

  const { rows } = await query<Row>(
    `SELECT id, title, description, category, original_filename, mime_type,
            size_bytes, uploaded_at, uploaded_by_email
       FROM school_documents
      WHERE school_id = $1 AND is_active = true
      ORDER BY COALESCE(NULLIF(category,''), 'zzz_other'),
               position, title`,
    [school.id],
  );

  // Distinct existing category labels for the suggestion datalist —
  // makes "use the same category I already use" easier.
  const categories = Array.from(new Set(
    rows.map((r) => r.category).filter((c): c is string => !!c && c.trim().length > 0),
  )).sort();

  // Bucket for display
  const byCat = new Map<string, Row[]>();
  for (const r of rows) {
    const cat = r.category && r.category.trim() ? r.category : 'Other';
    const ex = byCat.get(cat) ?? [];
    ex.push(r);
    byCat.set(cat, ex);
  }
  const orderedCats = [...byCat.keys()].sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });

  const returnTo = `/school/${locationId}/resources`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-emerald-600" />
            <h1 className="text-xl font-semibold text-gray-900">Resources for Parents</h1>
          </div>
          <p className="text-sm text-gray-600">
            Anything you upload here appears in every parent&apos;s portal under
            <span className="font-semibold"> Resources</span>. Common uses: school
            calendar, supply lists, parent handbook, classroom newsletters.
          </p>
        </header>

        {msg ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {msg}
          </div>
        ) : null}
        {err ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {err}
          </div>
        ) : null}

        {/* Upload form */}
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
          <h2 className="text-sm font-semibold text-emerald-900 mb-2 flex items-center gap-1.5">
            <Upload className="h-4 w-4" /> Upload a new document
          </h2>
          <form
            action="/api/school/resources/upload"
            method="POST"
            encType="multipart/form-data"
            className="space-y-3"
          >
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Title *</span>
                <input
                  name="title"
                  required
                  maxLength={200}
                  placeholder='e.g. "2026-27 School Calendar"'
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Category</span>
                <input
                  name="category"
                  list="resource-categories"
                  maxLength={80}
                  placeholder='e.g. "Calendar", "Forms", "Supply Lists"'
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                />
                <datalist id="resource-categories">
                  {categories.map((c) => <option key={c} value={c} />)}
                </datalist>
                <span className="block mt-0.5 text-[11px] text-gray-500">
                  Used to group related docs on the parent page. Leave blank for &quot;Other&quot;.
                </span>
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Description</span>
              <input
                name="description"
                maxLength={500}
                placeholder="Optional 1-line description shown below the title"
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">File *</span>
              <input
                type="file"
                name="file"
                required
                accept="application/pdf,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,text/plain,text/csv"
                className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-700"
              />
              <span className="block mt-0.5 text-[11px] text-gray-500">
                PDF, image, Word, Excel, CSV, or text. Up to 25 MB.
              </span>
            </label>
            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                <Upload className="h-3.5 w-3.5" /> Upload
              </button>
            </div>
          </form>
        </section>

        {/* Existing list */}
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
            <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
            <h3 className="text-base font-semibold text-gray-900">No resources yet</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
              Upload your first document above. Parents will see it the moment
              you upload — no publish button needed.
            </p>
          </div>
        ) : (
          <section className="space-y-5">
            <div className="text-xs text-gray-500">
              {rows.length} document{rows.length === 1 ? '' : 's'} live
            </div>
            {orderedCats.map((cat) => (
              <div key={cat} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {cat}
                </h3>
                <ul className="space-y-2">
                  {(byCat.get(cat) ?? []).map((d) => (
                    <DocAdminRow
                      key={d.id}
                      doc={d}
                      categories={categories}
                      returnTo={returnTo}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function DocAdminRow({
  doc, categories, returnTo,
}: {
  doc: Row;
  categories: string[];
  returnTo: string;
}) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3">
      <form
        action={`/api/school/resources/${doc.id}/update`}
        method="POST"
        encType="multipart/form-data"
        className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
      >
        <input type="hidden" name="return_to" value={returnTo} />
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Title</span>
          <input
            name="title"
            defaultValue={doc.title}
            required
            className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Category</span>
          <input
            name="category"
            defaultValue={doc.category ?? ''}
            list={`cats-${doc.id}`}
            className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <datalist id={`cats-${doc.id}`}>
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          Save
        </button>
        <label className="block sm:col-span-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">Description (optional)</span>
          <input
            name="description"
            defaultValue={doc.description ?? ''}
            placeholder="—"
            className="mt-0.5 block w-full rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
      </form>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-2">
        <div className="text-[11px] text-gray-500">
          {doc.original_filename} · {fmtBytes(doc.size_bytes)} · uploaded {fmtDate(doc.uploaded_at)}
          {doc.uploaded_by_email ? ` by ${doc.uploaded_by_email}` : ''}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/school/resources/${doc.id}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50"
          >
            <ExternalLink className="h-3 w-3" /> Preview
          </a>
          <DeleteResourceButton
            resourceId={doc.id}
            title={doc.title}
            returnTo={returnTo}
          />
        </div>
      </div>
    </li>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
