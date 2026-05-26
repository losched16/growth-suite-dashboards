// Shared top-nav for the teacher experience: tab bar with Roster /
// Submit Request / My Requests. Renders inside the classroom hub
// dashboards (where the active tab is 'roster') and the
// staff-requests pages (active tab 'submit' or 'mine').
//
// classroomSlug carries through the click flow so when a teacher
// clicks "Submit Request" from Classroom 3, then "Roster" again,
// they land back on classroom-3 (not the default).

import Link from 'next/link';
import { ClipboardList, Plus, Inbox, ArrowLeft, FolderOpen, Soup, Image as ImageIcon } from 'lucide-react';

export type ActiveTab = 'roster' | 'submit' | 'mine' | 'inbox' | 'documents' | 'menus' | 'lunch';

export function ClassroomTopNav({
  locationId,
  classroomSlug,
  classroomLabel,
  active,
}: {
  locationId: string;
  // Which classroom hub the teacher came from. May be null when the
  // teacher landed on the staff-requests pages without a classroom
  // context (e.g. via a direct link).
  classroomSlug: string | null;
  // Pretty label for the roster tab. Falls back to "Roster" when no
  // classroom context is available.
  classroomLabel: string | null;
  active: ActiveTab;
}) {
  const fromParam = classroomSlug ? `&from=${encodeURIComponent(classroomSlug)}` : '';

  // Roster tab links back to the classroom hub if we have one;
  // otherwise we point at the "All staff requests" landing.
  const rosterHref = classroomSlug
    ? `/school/${locationId}/${classroomSlug}?chrome=none`
    : `/school/${locationId}/staff-requests?chrome=none`;
  const rosterLabel = classroomLabel ?? 'Roster';

  const submitHref = `/school/${locationId}/staff-requests?chrome=none${fromParam}`;
  const mineHref   = `/school/${locationId}/staff-requests/mine?chrome=none${fromParam}`;

  // Documents tab → the existing "documents" dashboard (StudentDocumentsBrowser)
  // with the classroom name pre-filtered + audience=teacher so admin-only
  // files are hidden. The widget already accepts both as URL filters.
  const docsClassroomLabel = classroomSlug?.startsWith('classroom-')
    ? `Classroom ${classroomSlug.slice('classroom-'.length)}`
    : null;
  const docsParams = new URLSearchParams({ chrome: 'none', audience: 'teacher' });
  if (docsClassroomLabel) docsParams.set('classroom', docsClassroomLabel);
  if (classroomSlug)      docsParams.set('from', classroomSlug);
  const docsHref = `/school/${locationId}/documents?${docsParams.toString()}`;

  // Lunch + Menus pages also need the from= so the Roster tab keeps
  // a back-link to the original classroom hub.
  const lunchHref = `/school/${locationId}/lunch-roster?chrome=none${fromParam}`;
  const menusHref = `/school/${locationId}/menus?chrome=none${fromParam}`;

  return (
    <nav className="print:hidden border-b border-slate-200 bg-white -mx-4 sm:-mx-6 px-4 sm:px-6 mb-3">
      <div className="flex items-center gap-1 overflow-x-auto">
        <Tab
          href={rosterHref}
          active={active === 'roster'}
          icon={active !== 'roster' && classroomSlug ? <ArrowLeft className="h-3.5 w-3.5" /> : <ClipboardList className="h-3.5 w-3.5" />}
          label={rosterLabel}
        />
        <Tab
          href={submitHref}
          active={active === 'submit'}
          icon={<Plus className="h-3.5 w-3.5" />}
          label="Requests + Forms"
        />
        <Tab
          href={mineHref}
          active={active === 'mine'}
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="My Requests"
        />
        <Tab
          href={docsHref}
          active={active === 'documents'}
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          label="Documents"
        />
        <Tab
          href={lunchHref}
          active={active === 'lunch'}
          icon={<Soup className="h-3.5 w-3.5" />}
          label="Lunch Roster"
        />
        <Tab
          href={menusHref}
          active={active === 'menus'}
          icon={<ImageIcon className="h-3.5 w-3.5" />}
          label="Menus"
        />
      </div>
    </nav>
  );
}

function Tab({
  href, active, icon, label,
}: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px whitespace-nowrap';
  const cls = active
    ? `${base} border-blue-600 text-blue-700 font-semibold`
    : `${base} border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300`;
  return (
    <Link href={href} className={cls}>
      {icon}
      {label}
    </Link>
  );
}
