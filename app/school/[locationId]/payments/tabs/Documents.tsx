// Payments hub → Important Docs tab.
//
// Server component that renders the doc-management UI without
// outer page chrome (the payments hub already provides the iframe
// background + header + sub-nav + msg/err flash banners). Backed by
// the same APIs as the standalone /school/{locationId}/resources page
// — both surfaces hit /api/school/resources/{upload,update,delete}.
//
// School staff manage school-wide reference docs here: school calendar,
// parent handbook, supply lists, daily schedules, newsletter archive,
// Celebration of Life document, anything else parents don't sign.
// Goes live the moment the school clicks Upload — no publish step.

import { ExternalLink, Upload, FileText, BookOpen } from 'lucide-react';
import { query } from '@/lib/db';
import { DeleteResourceButton } from '../../resources/DeleteResourceButton';

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

// Starter category suggestions for brand-new schools — until they've
// uploaded their first doc the Category autocomplete would otherwise
// be empty. Once a school uses one of these it shows up in the
// existing-categories list and is filtered out of the suggestion list
// (case-insensitive) so we never duplicate.
const SUGGESTED_CATEGORIES = [
  'School Calendar',
  'Parent Handbook',
  'Newsletter Archive',
  'Daily Schedules',
  'Supply Lists',
  'Celebration of Life Document',
  'Forms & Reference',
];

export async function PaymentsHubDocuments({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const { rows } = await query<Row>(
    `SELECT id, title, description, category, original_filename, mime_type,
            size_bytes, uploaded_at, uploaded_by_email
       FROM school_documents
      WHERE school_id = $1 AND is_active = true
      ORDER BY COALESCE(NULLIF(category,''), 'zzz_other'),
               position, title`,
    [schoolId],
  );

  const existingCategories = Array.from(new Set(
    rows.map((r) => r.category).filter((c): c is string => !!c && c.trim().length > 0),
  )).sort();
  const seen = new Set(existingCategories.map((c) => c.toLowerCase()));
  const categories = [
    ...existingCategories,
    ...SUGGESTED_CATEGORIES.filter((s) => !seen.has(s.toLowerCase())),
  ];

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

  // Land back on this same tab after every action (upload / rename /
  // delete) so the operator never loses their place in the sub-nav.
  const returnTo = `/school/${locationId}/payments?tab=documents`;

  return (
    <div className="max-w-4xl space-y-5">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-emerald-600" />
          <h2 className="text-xl font-semibold text-slate-900">Important Documents</h2>
        </div>
        <p className="text-sm text-slate-600">
          Anything you upload here appears in every parent&apos;s portal under
          <span className="font-semibold"> Important Documents</span>. Use it
          for helpful reference docs parents <em>don&apos;t need to sign</em> —
          school calendar, parent handbook, newsletter archive, daily schedules,
          supply lists, Celebration of Life document, classroom-specific
          materials, anything else worth pinning.
        </p>
      </header>

      {/* Upload form */}
      <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
        <h3 className="text-sm font-semibold text-emerald-900 mb-2 flex items-center gap-1.5">
          <Upload className="h-4 w-4" /> Upload an important document
        </h3>
        <form
          action="/api/school/resources/upload"
          method="POST"
          encType="multipart/form-data"
          className="space-y-3"
        >
          <input type="hidden" name="return_to" value={returnTo} />
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Title *</span>
              <input
                name="title"
                required
                maxLength={200}
                placeholder='e.g. "2026-27 School Calendar"'
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Category</span>
              <input
                name="category"
                list={`docs-categories-${schoolId}`}
                maxLength={80}
                placeholder='e.g. "Calendar", "Forms", "Supply Lists"'
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              />
              <datalist id={`docs-categories-${schoolId}`}>
                {categories.map((c) => <option key={c} value={c} />)}
              </datalist>
              <span className="block mt-0.5 text-[11px] text-slate-500">
                Used to group related docs on the parent page. Leave blank for &quot;Other&quot;.
              </span>
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Description</span>
            <input
              name="description"
              maxLength={500}
              placeholder="Optional 1-line description shown below the title"
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">File *</span>
            <input
              type="file"
              name="file"
              required
              accept="application/pdf,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,text/plain,text/csv"
              className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-emerald-700"
            />
            <span className="block mt-0.5 text-[11px] text-slate-500">
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
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <h3 className="text-base font-semibold text-slate-900">No documents yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
            Upload your first document above. Parents will see it the moment
            you upload — no publish button needed.
          </p>
        </div>
      ) : (
        <section className="space-y-5">
          <div className="text-xs text-slate-500">
            {rows.length} document{rows.length === 1 ? '' : 's'} live
          </div>
          {orderedCats.map((cat) => (
            <div key={cat} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
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
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <form
        action={`/api/school/resources/${doc.id}/update`}
        method="POST"
        encType="multipart/form-data"
        className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
      >
        <input type="hidden" name="return_to" value={returnTo} />
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Title</span>
          <input
            name="title"
            defaultValue={doc.title}
            required
            className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Category</span>
          <input
            name="category"
            defaultValue={doc.category ?? ''}
            list={`cats-${doc.id}`}
            className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
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
          <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Description (optional)</span>
          <input
            name="description"
            defaultValue={doc.description ?? ''}
            placeholder="—"
            className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
      </form>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-2">
        <div className="text-[11px] text-slate-500">
          {doc.original_filename} · {fmtBytes(doc.size_bytes)} · uploaded {fmtDate(doc.uploaded_at)}
          {doc.uploaded_by_email ? ` by ${doc.uploaded_by_email}` : ''}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/school/resources/${doc.id}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
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
