'use client';

// Small client component that triggers window.print() and hides itself
// when the document is actually printing. Drop into any classroom /
// roster widget's header to give teachers a one-click "print this
// roster" affordance.
//
// Tailwind print: variants do the heavy lifting — anything tagged
// `print:hidden` disappears at print time. Use that on dashboard chrome
// (sidebar, filter rows, action buttons) so the printed page is just
// the data table.

import { Printer } from 'lucide-react';

export function PrintButton({
  label = 'Print',
  title = 'Print this roster',
}: { label?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      title={title}
      className="print:hidden inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-400"
    >
      <Printer className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
