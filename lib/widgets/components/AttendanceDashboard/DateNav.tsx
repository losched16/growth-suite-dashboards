'use client';

// Date navigation for the Attendance dashboard. The old UI was a bare
// date input + tiny "Go" submit that the office kept missing ("go back
// to previous dates ... currently not working"). This replaces it with:
//   ← / → one-click day arrows (plain links — nothing to submit),
//   a date picker that navigates the moment you pick a date,
//   and a "Today" reset when viewing the past.
// All navigation preserves the current query params (filters,
// embed_token, chrome) and swaps only `date`.

import type { WidgetSearchParams } from '@/lib/widgets/types';

function hrefFor(sp: WidgetSearchParams, dateIso: string, todayIso: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== 'date') p.set(k, v);
  }
  if (dateIso !== todayIso) p.set('date', dateIso);
  const qs = p.toString();
  return qs ? `?${qs}` : '?';
}

function shiftIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`); // noon UTC — immune to DST edges
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function DateNav({ sp, dateIso, todayIso }: {
  sp: WidgetSearchParams; dateIso: string; todayIso: string;
}) {
  const isToday = dateIso === todayIso;
  const btn = 'inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50';
  return (
    <div className="flex items-center gap-1">
      <a href={hrefFor(sp, shiftIso(dateIso, -1), todayIso)} className={btn} title="Previous day" aria-label="Previous day">←</a>
      <input
        type="date"
        value={dateIso}
        max={todayIso}
        onChange={(e) => {
          const v = e.target.value;
          if (v) window.location.href = hrefFor(sp, v, todayIso);
        }}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none"
      />
      {!isToday ? (
        <a href={hrefFor(sp, shiftIso(dateIso, 1), todayIso)} className={btn} title="Next day" aria-label="Next day">→</a>
      ) : (
        <span className={`${btn} opacity-40 cursor-default`} aria-hidden>→</span>
      )}
      {!isToday ? (
        <a href={hrefFor(sp, todayIso, todayIso)} className="ml-1 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-800">
          Today
        </a>
      ) : null}
    </div>
  );
}
