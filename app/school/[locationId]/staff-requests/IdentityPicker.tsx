// First-visit teacher picker. Shown on the staff-requests landing
// when no gsd_teacher_email cookie is set. Dropdown of DGM staff +
// an "Other / not listed" option that lets the user type a free
// email + name (covers subs, new hires, anyone not yet in the
// roster). Submitting POSTs to /identify which sets the cookies +
// redirects back here so the form picker is visible.

'use client';

import { useState } from 'react';
import { UserCircle, ChevronDown } from 'lucide-react';

interface Staff { email: string; name: string }

export function IdentityPicker({
  staff,
  returnTo,
}: {
  staff: Staff[];
  // Where to land after identifying. Usually the same /staff-requests
  // landing inside the iframe.
  returnTo: string;
}) {
  // Local UI state — selected email + (for "Other") typed email/name.
  const [picked, setPicked] = useState<string>('');
  const [otherEmail, setOtherEmail] = useState('');
  const [otherName, setOtherName] = useState('');
  const isOther = picked === '__other__';

  return (
    <div className="rounded-xl border-2 border-blue-300 bg-white p-5 sm:p-6 space-y-4 shadow-sm">
      <div className="flex items-start gap-3">
        <UserCircle className="h-7 w-7 text-blue-600 mt-0.5 shrink-0" />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Who&rsquo;s submitting this?</h2>
          <p className="text-xs text-slate-600 mt-1">
            Pick your name so Lexi knows who to follow up with — and so &ldquo;My Requests&rdquo; only shows your stuff.
            We&rsquo;ll remember you on this device for 30 days. You can switch users any time.
          </p>
        </div>
      </div>

      <form action="/api/school/staff-requests/identify" method="POST" className="space-y-3">
        <input type="hidden" name="return_to" value={returnTo} />

        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Your name</span>
          <div className="relative mt-1">
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="appearance-none block w-full rounded-md border border-slate-300 bg-white pr-8 pl-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
              required={!isOther}
              name={isOther ? '_picker_only' : 'teacher_email'}
            >
              <option value="">— pick from the staff list —</option>
              {staff.map((s) => (
                <option key={s.email} value={s.email}>{s.name} ({s.email})</option>
              ))}
              <option value="__other__">Other / not listed&hellip;</option>
            </select>
            <ChevronDown className="absolute right-2 top-2.5 h-4 w-4 text-slate-400 pointer-events-none" />
          </div>
        </label>

        {isOther ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 space-y-2">
            <p className="text-xs text-amber-900">
              You&rsquo;re identifying as someone not on the staff roster (sub, new hire, visitor). Both fields below are required.
            </p>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">Your email</span>
              <input
                type="email"
                name="teacher_email"
                required
                value={otherEmail}
                onChange={(e) => setOtherEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 block w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">Your name</span>
              <input
                type="text"
                name="teacher_name"
                required
                value={otherName}
                onChange={(e) => setOtherName(e.target.value)}
                placeholder="First Last"
                className="mt-1 block w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        ) : null}

        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
