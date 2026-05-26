// Student Documents Browser — Google Drive-like view of every document
// uploaded across the school. Searchable + filterable by student and
// category. Each row has a download link + delete button. Upload form
// at the top.
//
// School operators use this when they want to find a doc without
// knowing which student it's attached to ("did we ever get the
// Suzuki transcript?"). Per-student documents also show up inline on
// the Student Roster row (separate widget) — this is the cross-school
// view.

import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  studentDocumentsBrowserDefaults,
  studentDocumentsBrowserSchema,
  type StudentDocumentsBrowserConfig,
} from './config';
import { fetcher, type StudentDocumentsBrowserData, type DocumentRow } from './fetcher';
import { UploadForm } from './UploadForm';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { Download, Trash2, FileText, FileImage, FileType } from 'lucide-react';

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function iconFor(mime: string) {
  if (mime.startsWith('image/')) return <FileImage className="h-4 w-4 text-purple-600" />;
  if (mime.includes('pdf')) return <FileText className="h-4 w-4 text-rose-600" />;
  if (mime.includes('word') || mime.includes('document')) return <FileText className="h-4 w-4 text-blue-600" />;
  return <FileType className="h-4 w-4 text-slate-500" />;
}

function categoryColor(c: string | null) {
  switch (c) {
    case 'health':     return 'bg-emerald-100 text-emerald-800';
    case 'enrollment': return 'bg-blue-100 text-blue-800';
    case 'iep':        return 'bg-amber-100 text-amber-800';
    case 'transcript': return 'bg-violet-100 text-violet-800';
    default:           return 'bg-slate-100 text-slate-700';
  }
}

function Component({
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: StudentDocumentsBrowserConfig;
  data: StudentDocumentsBrowserData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Documents</h2>
          <p className="text-xs text-slate-500">
            {data.total.toLocaleString()} document{data.total === 1 ? '' : 's'} on file ·{' '}
            {fmtBytes(data.total_size_bytes)} total{data.filtered !== data.total ? ` (${data.filtered} shown by filter)` : ''}
          </p>
        </div>
        <UploadForm students={data.students} categories={data.categories} />
      </div>

      {/* Filter bar */}
      <AutoSubmitForm method="GET" className="flex flex-wrap gap-2 items-end rounded-lg border border-slate-200 bg-white p-3">
        <PreserveEmbedParams current={sp} />
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Search</span>
          <input
            type="search" name="q" defaultValue={sp.q ?? ''}
            placeholder="Title, filename, student name…"
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none min-w-[16rem]"
          />
        </label>
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Student</span>
          <select name="student" defaultValue={sp.student ?? ''} className="rounded border border-slate-300 bg-white px-2 py-1 text-sm">
            <option value="">All students</option>
            {data.students.map((s) => (
              <option key={s.id} value={s.id}>{s.display}{s.classroom_name ? ` · ${s.classroom_name}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Category</span>
          <select name="category" defaultValue={sp.category ?? ''} className="rounded border border-slate-300 bg-white px-2 py-1 text-sm">
            <option value="">All categories</option>
            {data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs ml-2">
          <input type="checkbox" name="parent_visible" value="1" defaultChecked={sp.parent_visible === '1'} className="h-3.5 w-3.5" />
          <span>Parent-visible only</span>
        </label>
        <noscript><button type="submit" className="rounded bg-blue-600 px-2 py-1 text-xs text-white">Apply</button></noscript>
        {(sp.q || sp.student || sp.category || sp.parent_visible) ? (
          <a href={clearHref(sp)} className="text-xs text-slate-500 hover:text-slate-700 underline">clear</a>
        ) : null}
      </AutoSubmitForm>

      {/* Documents table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium w-8"></th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Student</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Filename</th>
              <th className="px-3 py-2 font-medium text-right">Size</th>
              <th className="px-3 py-2 font-medium">Uploaded</th>
              <th className="px-3 py-2 font-medium text-center">Visibility</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.length === 0 ? (
              <tr><td colSpan={9} className="p-10 text-center text-sm text-slate-500 italic">
                No documents match the filters. Click <strong>Upload document</strong> to add one.
              </td></tr>
            ) : data.rows.map((d) => <Row key={d.id} d={d} />)}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {data.page_count > 1 ? (
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>
            Page {data.page} of {data.page_count} · {data.filtered} document{data.filtered === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2">
            <a href={pageHref(sp, Math.max(1, data.page - 1))}
              className={`rounded border border-slate-300 bg-white px-2 py-1 ${data.page === 1 ? 'opacity-30 pointer-events-none' : 'hover:bg-slate-50'}`}
            >← prev</a>
            <a href={pageHref(sp, Math.min(data.page_count, data.page + 1))}
              className={`rounded border border-slate-300 bg-white px-2 py-1 ${data.page === data.page_count ? 'opacity-30 pointer-events-none' : 'hover:bg-slate-50'}`}
            >next →</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function pageHref(current: WidgetSearchParams, n: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && k !== 'page') p.set(k, v);
  }
  p.set('page', String(n));
  return `?${p.toString()}`;
}

function Row({ d }: { d: DocumentRow }) {
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-3 py-2 align-top">{iconFor(d.mime_type)}</td>
      <td className="px-3 py-2 align-top">
        <div className="font-medium text-slate-900">{d.title}</div>
        {d.description ? <div className="text-[11px] text-slate-500 mt-0.5">{d.description}</div> : null}
        {d.expires_at ? <div className="text-[10px] text-amber-700 mt-0.5">Expires {d.expires_at}</div> : null}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="text-sm text-slate-900">{d.student_display}</div>
        {d.classroom_name ? <div className="text-[11px] text-slate-500">{d.classroom_name}</div> : null}
      </td>
      <td className="px-3 py-2 align-top">
        {d.category ? (
          <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${categoryColor(d.category)}`}>
            {d.category}
          </span>
        ) : <span className="text-slate-400 text-xs">—</span>}
      </td>
      <td className="px-3 py-2 align-top text-[11px] text-slate-600 font-mono truncate max-w-[14rem]" title={d.file_name}>
        {d.file_name}
      </td>
      <td className="px-3 py-2 align-top text-right text-xs text-slate-600 tabular-nums">{fmtBytes(d.size_bytes)}</td>
      <td className="px-3 py-2 align-top text-xs text-slate-500 whitespace-nowrap">
        {fmtDate(d.uploaded_at)}
        {d.uploaded_by ? <div className="text-[10px] text-slate-400">{d.uploaded_by}</div> : null}
      </td>
      <td className="px-3 py-2 align-top text-center">
        <div className="flex flex-col items-center gap-0.5">
          {d.visible_to_teacher ? <span className="text-[9px] text-emerald-700">teacher</span> : null}
          {d.visible_to_parent ? <span className="text-[9px] text-blue-700">parent</span> : null}
          {!d.visible_to_teacher && !d.visible_to_parent ? <span className="text-[9px] text-slate-400">admin only</span> : null}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-right whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          <a
            href={`/api/school/documents/${d.id}/download`}
            target="_blank" rel="noopener"
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
            title={`Download ${d.file_name}`}
          >
            <Download className="h-3 w-3" /> Open
          </a>
          <DeleteButton id={d.id} />
        </div>
      </td>
    </tr>
  );
}

// Tiny form-based delete (no JS state — full reload after submit).
// Wrapped in a one-line form so the operator can confirm via the
// browser's standard "are you sure" prompt added by onsubmit below.
function DeleteButton({ id }: { id: string }) {
  return (
    <form
      action={`/api/school/documents/${id}/delete`}
      method="POST"
      onSubmit={(e) => {
        if (!confirm('Delete this document? This cannot be undone.')) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit"
        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
        title="Delete this document"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </form>
  );
}

export const StudentDocumentsBrowser: WidgetDefinition<StudentDocumentsBrowserConfig, StudentDocumentsBrowserData> = {
  id: 'student_documents_browser',
  display_name: 'Documents',
  description: 'Searchable library of every document uploaded across the school, with per-student attachment + role visibility flags.',
  category: 'student',
  default_config: studentDocumentsBrowserDefaults,
  config_schema: studentDocumentsBrowserSchema,
  default_size: { w: 12, h: 16 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
