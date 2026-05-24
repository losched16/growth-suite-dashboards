'use client';

import { useState } from 'react';

interface EmbedRow {
  slug: string;
  display_name: string;
  is_enabled: boolean;
  url: string;          // chrome=none (single dashboard, no sidebar)
  urlWithNav: string;   // sidebar visible (lists every dashboard)
}

export function EmbedUrlsSection({ rows, baseHint }: { rows: EmbedRow[]; baseHint: string }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-lg font-semibold">Embed URLs</h2>
        <span className="text-xs text-zinc-500">paste into a GHL Dashboard widget</span>
      </div>
      <div className="rounded-xl border border-black/10 bg-white p-4">
        <p className="mb-3 text-xs text-zinc-600">
          Each URL embeds <strong>one dashboard</strong> for this school. Default mode
          hides the sidebar so you can control which dashboards each staff role sees
          — embed only the URLs they should access. Switch to <em>with nav</em> if
          you want the full dashboard list inside the iframe instead. Token is
          per-school and stable. Base:{' '}
          <code className="font-mono">{baseHint}</code>
        </p>
        <div className="space-y-2">
          {rows.map((r) => (
            <EmbedRowItem key={r.slug} row={r} />
          ))}
        </div>
      </div>
    </section>
  );
}

function EmbedRowItem({ row }: { row: EmbedRow }) {
  const [chrome, setChrome] = useState<'none' | 'full'>('none');
  const [copied, setCopied] = useState<'url' | 'iframe' | null>(null);

  const activeUrl = chrome === 'none' ? row.url : row.urlWithNav;
  const iframeSnippet = `<iframe src="${activeUrl}" style="width:100%;height:100%;border:0;" allow="clipboard-write"></iframe>`;

  async function copy(value: string, kind: 'url' | 'iframe') {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore — older browsers without clipboard API
    }
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
            {row.display_name}
            {!row.is_enabled ? (
              <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">
                disabled
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded border border-zinc-300 bg-white p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setChrome('none')}
            className={`rounded px-2 py-0.5 ${chrome === 'none' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'}`}
            title="Single dashboard, no sidebar"
          >
            dashboard only
          </button>
          <button
            type="button"
            onClick={() => setChrome('full')}
            className={`rounded px-2 py-0.5 ${chrome === 'full' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'}`}
            title="Sidebar lists every dashboard"
          >
            with nav
          </button>
        </div>
        <button
          type="button"
          onClick={() => copy(activeUrl, 'url')}
          className="shrink-0 rounded border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-100"
        >
          {copied === 'url' ? 'copied!' : 'copy URL'}
        </button>
        <button
          type="button"
          onClick={() => copy(iframeSnippet, 'iframe')}
          className="shrink-0 rounded border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-100"
        >
          {copied === 'iframe' ? 'copied!' : 'copy <iframe>'}
        </button>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{activeUrl}</div>
    </div>
  );
}
