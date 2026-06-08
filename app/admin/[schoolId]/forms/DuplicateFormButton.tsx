'use client';

// Per-row duplicate button for the forms list. POSTs the duplicate
// endpoint, then jumps the operator straight into the editor for the
// new draft so they can rename + edit before publishing. No confirm
// dialog — duplicating is non-destructive, undo = delete the draft.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Loader2 } from 'lucide-react';

export function DuplicateFormButton({
  schoolId, formId,
}: {
  schoolId: string;
  formId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(
        `/api/admin/schools/${schoolId}/forms/${formId}/duplicate`,
        { method: 'POST' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setBusy(false);
        return;
      }
      // Jump straight into the editor for the new draft.
      router.push(`/admin/${schoolId}/forms/${j.id}?msg=${encodeURIComponent('Duplicated — edit and publish when ready')}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        title="Duplicate this form into a new draft"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
        {busy ? 'Duplicating…' : 'Duplicate'}
      </button>
      {err ? (
        <div className="text-[10px] text-rose-700">{err}</div>
      ) : null}
    </>
  );
}
