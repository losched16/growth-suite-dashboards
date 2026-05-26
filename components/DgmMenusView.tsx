// Displays DGM's current monthly menu materials: Harvest of the Month
// chart, weekly snack menu, and the monthly organic lunch calendar.
// Used inside:
//   - /school/[locationId]/menus               (standalone page)
//   - /school/[locationId]/lunch-roster        (as one of two tabs)
//
// Each slot prefers a DB-uploaded image (via /api/school/menus/<slot>/file)
// and falls back to the bundled /public PNG when no upload exists. This
// keeps the page working out of the box AND lets designated editors
// swap the art without a deploy.
//
// Print button at the top fires window.print(); the section uses
// Tailwind print: variants so the iframe chrome and tab bar drop away
// and only the menus end up on the printed page.

import Image from 'next/image';
import { PrintButton } from '@/lib/widgets/components/_shared/PrintButton';
import { MENU_SLOTS } from '@/lib/menus';

// Receives the asset index from the page wrapper (which knows the
// school + can hit the DB). Each slot resolves to either the DB URL
// (with an uploaded_at cache buster) or the public fallback PNG.
export function DgmMenusView({
  assets,
}: {
  // slot -> { uploaded_at, ... } when an upload exists for that slot;
  // missing keys → use the fallback PNG.
  assets: Record<string, { id: string; uploaded_at: Date; uploaded_by: string | null; mime_type: string }>;
}) {
  const images = MENU_SLOTS.map((slot) => {
    const a = assets[slot.key];
    const v = a ? new Date(a.uploaded_at).getTime() : 0;
    const src = a ? `/api/school/menus/${slot.key}/file?v=${v}` : slot.fallbackPath;
    return {
      src,
      alt: slot.label,
      heading: slot.label,
      sub: slot.sub,
      isCustom: !!a,
      uploadedAt: a?.uploaded_at ?? null,
    };
  });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap print:hidden">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Kitchen menus</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Current lunch calendar, weekly snack menu, and the monthly Harvest highlight.
            Designated editors can swap any image via the <em>Edit menus</em> link.
          </p>
        </div>
        <PrintButton label="Print menus" />
      </div>

      <div className="space-y-6 print:space-y-3">
        {images.map((img) => (
          <section
            key={img.heading}
            className="rounded-lg border border-slate-200 bg-white overflow-hidden print:border-0 print:rounded-none"
          >
            <header className="px-4 py-2.5 border-b border-slate-100 bg-slate-50 print:bg-white print:border-0 flex items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">{img.heading}</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">{img.sub}</p>
              </div>
              {img.isCustom && img.uploadedAt ? (
                <span className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold print:hidden">
                  Updated {new Date(img.uploadedAt).toLocaleDateString()}
                </span>
              ) : null}
            </header>
            <div className="p-3 sm:p-4 flex justify-center">
              {/* `unoptimized` so a fresh upload through /api/school/menus
                  serves immediately without Next/Image's optimizer
                  caching a stale variant. */}
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
