'use client';

// School-side Forms tab row actions: Publish/Draft toggle + Delete.
//
// Talks to /api/admin/schools/[schoolId]/forms/[formId] (PATCH for
// the toggle, DELETE for removal). The DELETE endpoint requires a
// school-session OR operator cookie (added when we shipped this row's
// version of the controls), and confirms against ?confirm_count=N so
// a parent submission slipping in between display + click can't
// destroy data silently.

import { useState } from 'react';
import { Eye, EyeOff, Trash2, Loader2, AlertTriangle, Copy, Bell, BellOff, Send } from 'lucide-react';

export function FormRowActions({
  schoolId, locationId, formId, displayName, slug, isPublished, submissionCount,
  notificationsEnabled = true, notifyEmailsCount = 0,
}: {
  schoolId: string;
  // locationId is optional — when present, we route the duplicate
  // jump to the school-side editor (/school/<loc>/forms/<id>) so
  // operators stay inside the embedded GHL chrome. When absent we
  // fall back to /admin/<schoolId>/forms/<id>.
  locationId?: string;
  formId: string;
  displayName: string;
  slug: string;
  isPublished: boolean;
  submissionCount: number;
  notificationsEnabled?: boolean;
  // Length of the form's notify_emails array. Used so we can warn the
  // operator that flipping notifications back ON is a no-op if there's
  // no one in the list (they'd need to edit the form first).
  notifyEmailsCount?: number;
}) {
  const [published, setPublished] = useState(isPublished);
  const [togglingPub, setTogglingPub] = useState(false);
  const [notifyOn, setNotifyOn] = useState(notificationsEnabled);
  const [togglingNotify, setTogglingNotify] = useState(false);
  const [openDelete, setOpenDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  async function duplicate() {
    setDuplicating(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}/duplicate`, {
        method: 'POST',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setDuplicating(false);
        return;
      }
      // Jump straight into the editor for the new draft. Stay in the
      // school-side route if we know the locationId — keeps the
      // operator inside the embedded GHL chrome.
      const editorBase = locationId
        ? `/school/${locationId}/forms`
        : `/admin/${schoolId}/forms`;
      window.location.assign(`${editorBase}/${j.id}?msg=${encodeURIComponent('Duplicated — edit and publish when ready')}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDuplicating(false);
    }
  }

  const requireType = submissionCount > 0;
  const canDelete = requireType ? typed.trim() === 'DELETE' : true;

  async function toggleNotifications() {
    const next = !notifyOn;
    setTogglingNotify(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { notifications_enabled: next } }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setTogglingNotify(false);
        return;
      }
      setNotifyOn(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingNotify(false);
    }
  }

  async function togglePublish() {
    const next = !published;
    setTogglingPub(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/schools/${schoolId}/forms/${formId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { is_active: next } }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setTogglingPub(false);
        return;
      }
      setPublished(next);
      // Hard reload — the parent section header (Published vs Drafts)
      // depends on this state, so it's cleaner to just re-render the
      // whole tab than to lift state up.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setTogglingPub(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true); setErr(null);
    try {
      const r = await fetch(
        `/api/admin/schools/${schoolId}/forms/${formId}?confirm_count=${submissionCount}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.detail || j.error || `HTTP ${r.status}`);
        setDeleting(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <>
      {locationId && isPublished ? (
        <a
          href={`/school/${locationId}/forms/${formId}/send`}
          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50"
          title="Send this form to a specific family (emails them a one-click link)"
        >
          <Send className="h-3 w-3" /> Send
        </a>
      ) : null}
      <button
        type="button"
        onClick={togglePublish}
        disabled={togglingPub}
        className={
          published
            ? 'inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50'
            : 'inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50'
        }
        title={published ? 'Currently published. Click to unpublish (Draft → hidden from parents).' : 'Currently a draft. Click to publish (visible to parents).'}
      >
        {togglingPub ? <Loader2 className="h-3 w-3 animate-spin" /> : published ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        {published ? 'Published' : 'Draft'}
      </button>
      <button
        type="button"
        onClick={toggleNotifications}
        disabled={togglingNotify}
        className={
          notifyOn
            ? 'inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50'
            : 'inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'
        }
        title={notifyOn
          ? `Notifications ON — sending to ${notifyEmailsCount} recipient${notifyEmailsCount === 1 ? '' : 's'} per submission. Click to mute.`
          : `Notifications muted — submissions don't trigger email sends. Click to re-enable${notifyEmailsCount === 0 ? ' (but the notify list is empty — edit the form to add addresses first)' : ''}.`}
      >
        {togglingNotify ? <Loader2 className="h-3 w-3 animate-spin" /> : notifyOn ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
        {notifyOn ? `Notify (${notifyEmailsCount})` : 'Muted'}
      </button>
      <button
        type="button"
        onClick={duplicate}
        disabled={duplicating}
        className="inline-flex items-center gap-1 rounded border border-blue-300 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
        title="Duplicate this form into a new draft"
      >
        {duplicating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
        {duplicating ? 'Duplicating…' : 'Duplicate'}
      </button>
      <button
        type="button"
        onClick={() => { setOpenDelete(true); setErr(null); setTyped(''); }}
        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50"
        title="Delete this form"
      >
        <Trash2 className="h-3 w-3" /> Delete
      </button>
      {err && !openDelete ? (
        <div className="basis-full text-[11px] text-rose-700 mt-1">{err}</div>
      ) : null}

      {openDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !deleting && setOpenDelete(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-rose-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h2 className="text-base font-semibold text-slate-900">Delete &ldquo;{displayName}&rdquo;?</h2>
                <p className="mt-1 text-xs text-slate-500 font-mono">{slug}</p>
                {submissionCount > 0 ? (
                  <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                    <p className="font-semibold mb-1">This form has {submissionCount} parent submission{submissionCount === 1 ? '' : 's'}.</p>
                    <p>
                      Deleting will also <strong>permanently destroy all {submissionCount} submission{submissionCount === 1 ? '' : 's'}</strong> — including any uploaded files, signatures, and audit history. This can&rsquo;t be undone.
                    </p>
                    <p className="mt-2">
                      Consider flipping the <strong>Published</strong> button to <strong>Draft</strong> instead — parents won&rsquo;t see it, but the historical data stays intact.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-600">
                    No submissions exist yet, so the only thing being deleted is the form definition itself. Safe to remove.
                  </p>
                )}

                {requireType ? (
                  <label className="mt-3 block text-xs">
                    <span className="font-medium text-slate-700">Type <code className="rounded bg-slate-100 px-1">DELETE</code> to confirm:</span>
                    <input
                      type="text"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoFocus
                      className="mt-1 block w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-200"
                    />
                  </label>
                ) : null}

                {err ? (
                  <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{err}</div>
                ) : null}

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setOpenDelete(false)}
                    disabled={deleting}
                    className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDelete}
                    disabled={deleting || !canDelete}
                    className="inline-flex items-center gap-1 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                  >
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    {deleting ? 'Deleting…' : (submissionCount > 0 ? `Delete form + ${submissionCount} submission${submissionCount === 1 ? '' : 's'}` : 'Delete form')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
