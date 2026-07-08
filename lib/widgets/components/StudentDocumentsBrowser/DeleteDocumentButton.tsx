'use client';

// Tiny form-based delete with a native confirm. Client component — the
// onSubmit handler can't live in the server-rendered widget (RSC), which
// 500'd the whole Documents dashboard the first time it was mounted.

import { Trash2 } from 'lucide-react';

export function DeleteDocumentButton({ id }: { id: string }) {
  return (
    <form
      action={`/api/school/documents/${id}/delete`}
      method="POST"
      onSubmit={(e) => {
        if (!confirm('Delete this document? This cannot be undone.')) {
          e.preventDefault();
        }
      }}
    >
      <button type="submit"
        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
        title="Delete this document"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </form>
  );
}
