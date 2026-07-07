'use client';

// "Void — let family redo" for a submitted form. Confirms (this hands the
// family a fresh form), collects an optional reason, then plain-POSTs to
// the void endpoint which 303s back here with the result.

import { useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';

export function VoidSubmissionButton({
  submissionId, returnTo,
}: {
  submissionId: string;
  returnTo: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [reason, setReason] = useState('');

  function onClick() {
    const ok = window.confirm(
      'Void this submission?\n\nThe family\'s form unlocks immediately so they can fill it out again. '
      + 'This copy stays on record as "voided" for the audit trail, but stops counting as completed.',
    );
    if (!ok) return;
    const r = window.prompt('Optional: why is it being voided? (visible to staff only)', '');
    setReason(r ?? '');
    // Submit on the next tick so the reason state lands in the hidden input.
    setTimeout(() => formRef.current?.submit(), 0);
  }

  return (
    <form ref={formRef} action={`/api/school/forms/submissions/${submissionId}/void`} method="POST">
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="reason" value={reason} />
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
        title="Void this submission so the family can fill the form out again"
      >
        <Undo2 className="h-3.5 w-3.5" /> Void — let family redo
      </button>
    </form>
  );
}
