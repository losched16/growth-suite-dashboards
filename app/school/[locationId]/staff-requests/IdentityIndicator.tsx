// "Signed in as X — switch" pill, shown at the top of every
// staff-requests page once a teacher has identified themselves. The
// "switch" link posts to /identify/clear which wipes the cookie and
// sends them back to the picker.

import { UserCircle, LogOut } from 'lucide-react';

export function IdentityIndicator({
  email,
  name,
  returnTo,
}: {
  email: string;
  name: string | null;
  returnTo: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs text-emerald-900">
      <UserCircle className="h-3.5 w-3.5 text-emerald-700" />
      <span>
        Signed in as <strong>{name ?? email}</strong>
        {name ? <span className="text-emerald-600 ml-1">({email})</span> : null}
      </span>
      <form action="/api/school/staff-requests/identify/clear" method="POST" className="inline">
        <input type="hidden" name="return_to" value={returnTo} />
        <button
          type="submit"
          className="inline-flex items-center gap-0.5 text-emerald-700 hover:text-emerald-900 underline"
          title="Clear the saved identity on this device and pick a different teacher"
        >
          <LogOut className="h-3 w-3" /> switch
        </button>
      </form>
    </div>
  );
}
