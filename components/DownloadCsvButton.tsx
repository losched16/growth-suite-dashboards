'use client';

// Download button for the /api/export/* endpoints.
//
// Embedded inside a cross-site GHL iframe, a plain `<a download target="_top">`
// is fragile: it navigates the TOP frame out to the file URL, where the
// partitioned session cookie isn't sent and a non-200 surfaces as the
// browser's "this file isn't available on this site" page. Instead we
// FETCH the CSV from within the iframe (same-origin → the partitioned
// cookie IS sent) and trigger a local blob download — no navigation, so
// nothing can land on an error page. If the fetch itself fails we fall
// back to opening the URL in a new tab.

import { useState } from 'react';
import { Download } from 'lucide-react';

export function DownloadCsvButton({
  href,
  label = 'Download CSV',
  size = 'sm',
}: {
  href: string;
  label?: string;
  size?: 'sm' | 'xs';
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const cls =
    size === 'xs'
      ? 'inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-60'
      : 'inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60';

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(href, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();

      // Prefer the server's filename (Content-Disposition), else derive one.
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(cd);
      const filename = m ? decodeURIComponent(m[1]) : 'export.csv';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch {
      // Fetch/blob path blocked (e.g. sandboxed iframe) — fall back to a
      // new tab, which the browser handles as a normal file download.
      setFailed(true);
      window.open(href, '_blank', 'noopener');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={busy} className={cls}>
      <Download className={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {busy ? 'Preparing…' : failed ? 'Opened in new tab' : label}
    </button>
  );
}
