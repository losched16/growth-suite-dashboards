// Server section: the "Important documents" manager (composer + list).
// Mounted on the Portal Forms page (one spot for everything parents see)
// and on the standalone /documents page.

import { FolderOpen, Download } from 'lucide-react';
import { query } from '@/lib/db';
import { loadAudienceOptions } from '@/lib/notifications/audience';
import { ShareDocument, DocActions } from './ShareDocument';

interface DocRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  file_name: string;
  size_bytes: number;
  audience_label: string | null;
  is_active: boolean;
  uploaded_at: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function SharedDocsSection({ schoolId }: { schoolId: string }) {
  const options = await loadAudienceOptions(schoolId);
  const { rows: docs } = await query<DocRow>(
    `SELECT id, title, description, category, file_name, size_bytes,
            audience_label, is_active,
            to_char(uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS uploaded_at
       FROM school_shared_documents
      WHERE school_id = $1
      ORDER BY uploaded_at DESC`,
    [schoolId],
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-emerald-700" /> Important documents
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Files shared here appear in each matching family&rsquo;s parent portal under
          Documents &rarr; &ldquo;From your school&rdquo;. Targeting follows the family live —
          tag or classroom changes update who sees what automatically.
        </p>
      </div>

      <ShareDocument schoolId={schoolId} options={options} />

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Shared documents ({docs.length})</h3>
        {docs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-xs text-slate-500 italic">
            Nothing shared yet — upload the handbook, calendar, or program packets above.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white overflow-hidden">
            {docs.map((d) => (
              <li key={d.id} className={`px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${d.is_active ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a href={`/api/admin/schools/${schoolId}/shared-documents/${d.id}`}
                       className="text-sm font-medium text-slate-900 hover:underline truncate">
                      {d.title}
                    </a>
                    {d.category ? (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0 text-[10px] text-slate-600">{d.category}</span>
                    ) : null}
                    {!d.is_active ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800">hidden</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {d.file_name} · {fmtBytes(d.size_bytes)} · visible to: <span className="text-slate-700">{d.audience_label ?? 'everyone'}</span>
                  </div>
                  {d.description ? <div className="mt-0.5 text-[11px] text-slate-600 italic">{d.description}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  <a href={`/api/admin/schools/${schoolId}/shared-documents/${d.id}`}
                     className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
                    <Download className="h-3.5 w-3.5" />
                  </a>
                  <DocActions schoolId={schoolId} docId={d.id} isActive={d.is_active} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
