// Small affordance — link that triggers a CSV download from one of the
// /api/export/* endpoints. Server-rendered, no JS needed.
//
// Pass `href` (already-built URL with embed_token + filters baked in) and
// optionally a `label`. Renders as a button-shaped link.

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
  const cls =
    size === 'xs'
      ? 'inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50'
      : 'inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50';
  return (
    <a href={href} className={cls} download target="_top" rel="noopener">
      <Download className={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> {label}
    </a>
  );
}
