// /staff — staff sign-in for standalone (non-GHL) schools. Email →
// magic link → gsd_school_session cookie → school dashboard home.
// Schools embedded in Growth Suite never see this; their session comes
// from the embed exchange automatically. (/login is the operator
// password page — different audience.)

import { Mail, ShieldCheck } from 'lucide-react';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ sent?: string; err?: string }>;

export default async function StaffLoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <div className="mb-5 flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-emerald-700" />
            <h1 className="text-xl font-semibold text-slate-900">School staff sign-in</h1>
          </div>

          {sp.err === 'expired' ? (
            <div className="mb-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              That sign-in link expired or was already used. Request a fresh one below.
            </div>
          ) : null}

          {sp.sent ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <div className="flex items-center gap-2 font-semibold"><Mail className="h-4 w-4" /> Check your email</div>
              <p className="mt-1 text-emerald-800">
                If that address belongs to a school staff member, a sign-in link is on its way.
                It expires in 15 minutes.
              </p>
            </div>
          ) : (
            <form action="/api/auth/staff/request" method="POST" className="space-y-3">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-600">Work email</span>
                <input
                  type="email" name="email" required autoFocus placeholder="you@school.org"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
                />
              </label>
              <button type="submit" className="w-full rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
                Email me a sign-in link
              </button>
              <p className="text-[11px] text-slate-500">
                No passwords — we email you a secure one-time link. Ask your school&apos;s administrator
                to add you if you don&apos;t receive one.
              </p>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
