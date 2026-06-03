'use client';

// Small client island for the per-row Remove button. Lives outside
// the server page so the confirm() prompt can run, but the actual
// delete still happens via a real form POST to the existing endpoint
// (no fetch / no JSON wrangling — matches the rest of the admin UI).

import { Trash2 } from 'lucide-react';

export function DeleteResourceButton({
  resourceId,
  title,
  returnTo,
}: {
  resourceId: string;
  title: string;
  returnTo: string;
}) {
  return (
    <form
      action={`/api/school/resources/${resourceId}/delete`}
      method="POST"
      onSubmit={(e) => {
        if (!confirm(`Remove "${title}" from the parent portal?\n\nThe file stays in our records (audit log), but parents will no longer see it.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="return_to" value={returnTo} />
      <button
        type="submit"
        className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50"
      >
        <Trash2 className="h-3 w-3" /> Remove
      </button>
    </form>
  );
}
