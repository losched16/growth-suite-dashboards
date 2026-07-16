'use client';

// A submit button that fires exactly once. On the first click it lets the
// native form POST proceed, then immediately disables itself so a second
// click (or an impatient double-click) can't submit the form twice.
//
// Why this exists: the manual invoice-create form is a plain POST form. A
// double-click created the SAME invoice twice (two "Late fee" invoices two
// seconds apart). Disabling after the first submit closes that gap without a
// server round-trip. Use in place of a bare <button type="submit">.

import { useState } from 'react';

export function SubmitOnce({
  children,
  className,
  pendingLabel = 'Working…',
}: {
  children: React.ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  return (
    <button
      type="submit"
      disabled={submitting}
      aria-busy={submitting}
      className={className}
      style={submitting ? { opacity: 0.7, cursor: 'progress' } : undefined}
      onClick={(e) => {
        // Already submitting → swallow the extra click.
        if (submitting) { e.preventDefault(); return; }
        // Defer disabling to the next tick so THIS click still submits the
        // form natively; the disabled state then blocks any follow-up click.
        setTimeout(() => setSubmitting(true), 0);
      }}
    >
      {submitting ? pendingLabel : children}
    </button>
  );
}
