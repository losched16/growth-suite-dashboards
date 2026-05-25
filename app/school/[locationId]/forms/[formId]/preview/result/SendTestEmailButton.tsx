'use client';

// Inline "Send notification email to me" control on the test result
// page. Default-fills with the school session's user_email when we can
// fetch it; otherwise the operator types an address.
//
// Sends to the /test-submit/send-email endpoint which renders the
// production notification email and fires it via the same sendBrandedEmail
// pipeline real submissions use.

import { useState, type FormEvent } from 'react';
import { Loader2, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';

export function SendTestEmailButton({
  schoolId,
  formId,
  submissionId,
  defaultTo = '',
}: {
  schoolId: string;
  formId: string;
  submissionId: string;
  defaultTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const [toEmail, setToEmail] = useState(defaultTo);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'ok'; sent_to: string }
    | { kind: 'err'; detail: string }
    | null
  >(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(
        `/api/admin/schools/${schoolId}/forms/${formId}/test-submit/send-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submission_id: submissionId, to_email: toEmail }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; sent_to?: string; detail?: string; error?: string };
      if (!r.ok || !j.ok) {
        setResult({ kind: 'err', detail: j.detail || j.error || `HTTP ${r.status}` });
      } else {
        setResult({ kind: 'ok', sent_to: j.sent_to ?? toEmail });
      }
    } catch (e2) {
      setResult({ kind: 'err', detail: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        title="Send the EXACT email a real office recipient would get, to an address you choose. Uses the production renderer and sends through the real email pipeline."
      >
        <Mail className="h-3 w-3" /> Send notification email to me
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <Mail className="h-4 w-4 text-zinc-500" />
      <input
        type="email"
        value={toEmail}
        onChange={(e) => setToEmail(e.target.value)}
        placeholder="you@yourschool.com"
        required
        disabled={busy}
        className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs w-56 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
      />
      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
        {busy ? 'Sending…' : 'Send'}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setResult(null); }}
        disabled={busy}
        className="text-[11px] text-zinc-500 hover:text-zinc-700 hover:underline disabled:opacity-50"
      >
        cancel
      </button>
      {result?.kind === 'ok' ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-2 py-1 text-[11px] text-emerald-800">
          <CheckCircle2 className="h-3 w-3" /> Sent to {result.sent_to}
        </span>
      ) : null}
      {result?.kind === 'err' ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 border border-rose-200 px-2 py-1 text-[11px] text-rose-800">
          <AlertCircle className="h-3 w-3" /> {result.detail}
        </span>
      ) : null}
    </form>
  );
}
