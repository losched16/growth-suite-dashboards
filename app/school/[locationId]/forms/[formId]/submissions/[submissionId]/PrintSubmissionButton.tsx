'use client';

// "Print / Save as PDF" button on the submission detail page.
//
// On click → window.print(). The browser's native print dialog includes
// a "Save as PDF" destination on every major browser (Chrome, Safari,
// Edge, Firefox) so admins can save / email / archive any submission
// with a proper signature image, in a layout that's been styled with
// `print:` Tailwind classes upstream.
//
// `autoPrint=true` (set when the URL has ?print=1) fires the dialog
// automatically on mount — used when admin clicks the "PDF" chip from
// the per-family forms page.

import { useEffect } from 'react';
import { Printer } from 'lucide-react';

export function PrintSubmissionButton({ autoPrint = false }: { autoPrint?: boolean }) {
  useEffect(() => {
    if (!autoPrint) return;
    // Tiny delay so the page is fully painted (signature image loaded)
    // before the print dialog snapshots it.
    const id = setTimeout(() => window.print(), 250);
    return () => clearTimeout(id);
  }, [autoPrint]);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
    >
      <Printer className="h-3.5 w-3.5" />
      Print / Save as PDF
    </button>
  );
}
