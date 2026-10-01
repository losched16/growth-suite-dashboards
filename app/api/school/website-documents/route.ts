// POST /api/school/website-documents — upload ONE document for the school's
// public marketing website (a classroom newsletter, a lunch menu).
//
// One file per request, like the gallery's photo endpoint, so the manager
// can show per-file progress and per-file errors when a school drops five
// newsletters in at once.
//
// Body (multipart/form-data):
//   file     — the document (PDF, image, Word)        required
//   label    — card heading, e.g. "Maple Tree Classroom"  required
//   section  — 'newsletter' | 'menu' | other slug     default 'newsletter'
//   month    — 'YYYY-MM' the document is FOR          optional but expected
//
// Returns: { document: { id, section, label, period_month, ... } }
//
// school_id comes from the school session cookie, never the request, so an
// operator can only ever upload against their own school.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB, same ceiling as portal resources

// What a school actually posts here. Anything else is refused rather than
// stored, because these bytes get served to the open web under the school's
// own domain.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function sectionOf(v: string): string {
  const s = v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
  return s || 'newsletter';
}

/** 'YYYY-MM' -> 'YYYY-MM-01', or null. Rejects anything else rather than
 *  letting Postgres guess at a half-typed date. */
function monthOf(v: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const label = String(fd.get('label') ?? '').trim().slice(0, 120);
  const section = sectionOf(String(fd.get('section') ?? ''));
  const monthRaw = String(fd.get('month') ?? '').trim();
  const period = monthRaw ? monthOf(monthRaw) : null;
  const file = fd.get('file');

  if (!label) return NextResponse.json({ error: 'A name for the card is required.' }, { status: 400 });
  if (monthRaw && !period) return NextResponse.json({ error: 'Month must look like 2026-08.' }, { status: 400 });
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'Please attach a file.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).` },
      { status: 400 },
    );
  }
  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { error: 'Please upload a PDF, image, or Word document.' },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // Re-uploading the same classroom for the same month replaces the card
  // rather than adding a second one next to it — which is what a school
  // means when they send a corrected newsletter. Undated rows are left
  // alone; there is no slot to collide with.
  if (period) {
    await query(
      `DELETE FROM website_documents
        WHERE school_id = $1 AND section = $2 AND period_month = $3
          AND lower(label) = lower($4)`,
      [session.school_id, section, period, label],
    );
  }

  const { rows } = await query<{
    id: string; section: string; label: string; period_month: string | null;
    original_filename: string; mime_type: string; size_bytes: number; is_published: boolean;
  }>(
    `INSERT INTO website_documents
       (school_id, section, label, period_month,
        original_filename, mime_type, size_bytes, contents,
        position, uploaded_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT COALESCE(MAX(position), 0) + 10
                FROM website_documents
               WHERE school_id = $1 AND section = $2
                 AND period_month IS NOT DISTINCT FROM $4),
             $9)
     RETURNING id, section, label, to_char(period_month, 'YYYY-MM-DD') AS period_month,
               original_filename, mime_type, size_bytes, is_published`,
    [
      session.school_id, section, label, period,
      file.name, mime, bytes.length, bytes,
      session.user_email ?? null,
    ],
  );

  return NextResponse.json({ document: rows[0] }, { status: 201 });
}
