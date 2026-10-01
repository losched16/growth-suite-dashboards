// GET /api/website/documents/{locationId} — PUBLIC document feed for a
// school's marketing website. FLMA's static Parent Resources page fetches
// this and renders the download cards client-side, so the school publishes
// next month's newsletters from the dashboard and the page follows along
// with no deploy.
//
// Public + CORS-open on purpose, exactly like the gallery feed: this is
// material the school wants on the open web. Only PUBLISHED rows are
// returned, and only metadata — the bytes come from
// /api/website/documents/file/{id}.
//
// Unknown location, or a school that has not uploaded anything, answers
// { sections: [] } rather than an error, so a site can ship the widget
// before the school's first upload and simply show its own fallback.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ locationId: string }>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  // Short cache: a school that uploads a newsletter wants to see it on the
  // site within a couple of minutes, not next hour.
  'Cache-Control': 'public, max-age=120, s-maxage=120',
};

// Titles the website uses for each known section. A section we don't know
// still comes through, under its own raw key, so adding one on the admin
// side never needs a change here.
const SECTION_TITLES: Record<string, string> = {
  newsletter: 'Classroom Newsletters & Lesson Plans',
  menu: 'Lunch Menus',
};

interface DocRow {
  id: string;
  section: string;
  label: string;
  period_month: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
}

/** "2026-08-01" -> "August 2026". Parsed by hand: a date-only string put
 *  through Date() is UTC midnight, which prints as the previous month for
 *  anyone west of Greenwich. */
function monthLabel(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = Number(m[2]) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${m[1]}` : null;
}

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  try {
    const { rows: schoolRows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM schools WHERE ghl_location_id = $1`,
      [locationId],
    );
    if (schoolRows.length === 0) {
      return NextResponse.json({ school: null, sections: [] }, { headers: CORS });
    }
    const school = schoolRows[0];

    const { rows } = await query<DocRow>(
      `SELECT id, section, label,
              to_char(period_month, 'YYYY-MM-DD') AS period_month,
              original_filename, mime_type, size_bytes
         FROM website_documents
        WHERE school_id = $1 AND is_published = true
        ORDER BY section, period_month DESC NULLS LAST, position, label`,
      [school.id],
    );

    // section -> month -> documents, both already in the order the site
    // should render them thanks to the ORDER BY above.
    const bySection = new Map<string, Map<string, DocRow[]>>();
    for (const r of rows) {
      const months = bySection.get(r.section) ?? new Map<string, DocRow[]>();
      const key = r.period_month ?? '';
      const docs = months.get(key) ?? [];
      docs.push(r);
      months.set(key, docs);
      bySection.set(r.section, months);
    }

    const sections = [...bySection.entries()].map(([key, months]) => ({
      key,
      title: SECTION_TITLES[key] ?? null,
      months: [...months.entries()].map(([period, docs]) => ({
        period_month: period || null,
        period_label: monthLabel(period || null),
        documents: docs.map((d) => ({
          id: d.id,
          label: d.label,
          filename: d.original_filename,
          mime: d.mime_type,
          size_bytes: d.size_bytes,
        })),
      })),
    }));

    // Newsletters before menus before anything else, so the site can render
    // the feed in order without knowing our section names.
    const RANK = ['newsletter', 'menu'];
    sections.sort((a, b) => {
      const ra = RANK.indexOf(a.key); const rb = RANK.indexOf(b.key);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.key.localeCompare(b.key);
    });

    return NextResponse.json(
      { school: { name: school.name }, sections },
      { headers: CORS },
    );
  } catch {
    return NextResponse.json({ school: null, sections: [] }, { headers: CORS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
