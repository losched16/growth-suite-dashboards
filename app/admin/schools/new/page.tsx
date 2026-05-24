// New-school onboarding form. Operator pastes the school's GHL Location
// ID + Private Integration Token; we validate the PIT, encrypt it,
// insert the row, then redirect to the school admin so they can run
// "Sync from GHL" + "Promote Parent 2 to GHL contacts".

import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ msg?: string; err?: string }>;

export default async function NewSchoolPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { msg, err } = await searchParams;

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6">
      <div className="w-full max-w-2xl space-y-5">
        <div>
          <Link href="/admin" className="text-xs text-zinc-500 hover:text-zinc-700">
            ← All schools
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Add a school</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Onboards a new school into the platform. After creation, you&apos;ll be redirected
            to the school admin where you can run sync + Parent 2 promotion.
          </p>
        </div>

        {msg ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div>
        ) : null}
        {err ? (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
        ) : null}

        <form
          action="/api/admin/schools/create"
          method="POST"
          className="space-y-4 rounded-xl border border-black/10 bg-white p-5"
        >
          <label className="block">
            <span className="text-sm font-medium text-zinc-900">School name</span>
            <input
              type="text"
              name="name"
              required
              placeholder="e.g. Wooster Family Hub"
              className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-500">Display name only — shown in admin + dashboards.</p>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-zinc-900">GHL Location ID</span>
            <input
              type="text"
              name="ghl_location_id"
              required
              placeholder="e.g. wy1qNRECEgy8lg8pKqm0"
              className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-mono focus:border-emerald-600 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              In GHL: Settings → Business Info → Location ID. ~20 alphanumeric chars.
            </p>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-zinc-900">Private Integration Token (PIT)</span>
            <textarea
              name="ghl_pit"
              required
              rows={3}
              placeholder="pit-abc123…"
              className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-xs font-mono focus:border-emerald-600 focus:outline-none"
            />
            <div className="mt-1 text-[11px] text-zinc-500">
              In GHL: Settings → Private Integrations → New Token. Required scopes:
              <code className="ml-1 font-mono text-[10px] bg-zinc-100 px-1 rounded">contacts.readonly contacts.write locations/customFields.readonly associations.write associations/relation.write opportunities.readonly conversations.readonly conversations/message.write medias.write</code>
              <br />
              <strong className="text-amber-700">Stored AES-256-GCM encrypted. We validate the PIT before saving — if it&apos;s invalid you&apos;ll see an error here, nothing gets written.</strong>
            </div>
          </label>

          <div className="flex items-center gap-3 pt-2 border-t border-zinc-100">
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Create &amp; continue
            </button>
            <Link href="/admin" className="text-xs text-zinc-500 hover:text-zinc-700">
              Cancel
            </Link>
          </div>
        </form>

        {/* Helper: what happens next */}
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-700">
          <h2 className="mb-1.5 font-semibold text-zinc-900">After you click Create:</h2>
          <ol className="space-y-1 ml-4 list-decimal">
            <li>We POST to <code className="font-mono bg-white px-1 rounded">/locations/&#123;id&#125;/customFields</code> to validate the PIT</li>
            <li>If valid, we AES-256-GCM encrypt the PIT and insert a <code className="font-mono">schools</code> row</li>
            <li>You&apos;re redirected to <code className="font-mono">/admin/&#123;newSchoolId&#125;</code></li>
            <li>From there, click <strong>Sync from GHL</strong> (pulls families + students)</li>
            <li>Then <strong>Promote Parent 2 to GHL contacts</strong> (creates standalone P2 contacts + co-parent associations)</li>
            <li>You can show them embed URLs / dashboards immediately</li>
          </ol>
        </div>
      </div>
    </main>
  );
}
