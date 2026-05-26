// Displays DGM's current monthly menu materials: Harvest of the Month
// chart, weekly snack menu, and the monthly organic lunch calendar.
// Used inside:
//   - /school/[locationId]/menus               (standalone page)
//   - /school/[locationId]/lunch-roster        (as one of two tabs)
//
// Images live in /public/dgm-menus/ — operators replace them in-place
// when DGM publishes a new month. No code change needed to swap the
// art, just re-upload over the same filenames.
//
// Print button at the top fires window.print(); the section uses
// Tailwind print: variants so the iframe chrome and tab bar drop away
// and only the menus end up on the printed page.

import Image from 'next/image';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';

// Filenames are hardcoded so the user just drops the new month's
// images on top of the existing ones (idempotent — no migration).
const IMAGES = [
  {
    src: '/dgm-menus/lunch-calendar.png',
    alt: 'DGM Organic Lunch Calendar — current month',
    heading: 'Monthly Lunch Calendar',
    sub: 'What’s served each day this month',
  },
  {
    src: '/dgm-menus/daily-snack-menu.png',
    alt: 'DGM Daily Snack Menu — current weeks',
    heading: 'Weekly Snack Menu',
    sub: 'Snacks for Infant and Toddler/Primary rooms',
  },
  {
    src: '/dgm-menus/harvest-of-the-month.png',
    alt: 'Harvest of the Month chart — monthly featured produce',
    heading: 'Harvest of the Month',
    sub: 'The veggie / fruit / grain / bean / herb featured each month',
  },
];

export function DgmMenusView() {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap print:hidden">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Kitchen menus</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Current lunch calendar, weekly snack menu, and the monthly Harvest highlight.
            Swap a month by re-uploading the image with the same filename in
            <code className="mx-1 px-1 rounded bg-slate-100 text-slate-700">/public/dgm-menus/</code>.
          </p>
        </div>
        <PrintButton label="Print menus" />
      </div>

      <div className="space-y-6 print:space-y-3">
        {IMAGES.map((img) => (
          <section
            key={img.src}
            className="rounded-lg border border-slate-200 bg-white overflow-hidden print:border-0 print:rounded-none"
          >
            <header className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 print:bg-white print:border-0">
              <h3 className="text-sm font-semibold text-slate-900">{img.heading}</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">{img.sub}</p>
            </header>
            <div className="p-3 sm:p-4 flex justify-center">
              {/* Use unoptimized so dropping in a new image takes effect
                  on the next request — Next/Image's optimizer doesn't
                  re-process unchanged URLs aggressively. */}
              <Image
                src={img.src}
                alt={img.alt}
                width={1200}
                height={900}
                className="w-full max-w-3xl h-auto"
                unoptimized
                priority
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
