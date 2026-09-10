'use client';

// Submit button for the bulk-invoice form that visibly commits on first
// click and refuses a second one.
//
// The form is a plain POST to the API route, so the browser shows nothing
// while the request runs. On 2026-09-09 NLMA's office clicked "Create bulk
// invoices" repeatedly during a slow send and produced 116 invoices instead
// of ~30. Disabling the button on submit closes that door at the source;
// the route has its own repeat-send guard as a second line.

import { useEffect, useRef, useState } from 'react';

export function BulkSubmitButton({ label = 'Create bulk invoices' }: { label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = () => setBusy(true);
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  }, []);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={busy}
      aria-busy={busy}
      className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-70"
    >
      {busy ? (
        <>
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
          Creating invoices… don&rsquo;t click again
        </>
      ) : label}
    </button>
  );
}
