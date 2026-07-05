// POST /api/school/{locationId}/forms/import
// Body (multipart): EITHER pdf=<file> OR google_url=<url>
//
// AI-imports a school's existing form (PDF upload or public Google Form link)
// into a DRAFT portal form, then drops the school into the builder to refine
// field types / dropdown options / conditional logic / GHL field mapping and
// publish. Additive — existing forms are never touched.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { parseFormFromPdf, parseFormFromGoogleForm, type ImportedForm } from '@/lib/forms/import';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // the Claude parse can take 20-40s

type Params = Promise<{ locationId: string }>;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  const authorized = isOperator || (schoolSession && schoolSession.school_id === school.id);
  if (!authorized) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const back = (q: { err?: string }) => {
    const url = new URL(`/school/${locationId}/forms/new`, request.nextUrl);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  const form = await request.formData().catch(() => null);
  if (!form) return back({ err: 'Could not read the upload.' });

  const googleUrl = String(form.get('google_url') ?? '').trim();
  const pdf = form.get('pdf');

  try {
    let imported: ImportedForm;

    if (googleUrl) {
      if (!/^https?:\/\/(docs\.google\.com|forms\.gle)\//i.test(googleUrl)) {
        return back({ err: 'That doesn’t look like a Google Form link (expected docs.google.com/forms/… or forms.gle/…).' });
      }
      imported = await parseFormFromGoogleForm(googleUrl);
    } else if (pdf && typeof pdf === 'object' && 'arrayBuffer' in pdf) {
      const file = pdf as File;
      if (file.type && file.type !== 'application/pdf') {
        return back({ err: 'Please upload a PDF (or paste a Google Form link).' });
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) return back({ err: 'That PDF was empty.' });
      if (bytes.byteLength > MAX_PDF_BYTES) return back({ err: 'That PDF is too large (max 12 MB).' });
      imported = await parseFormFromPdf(Buffer.from(bytes).toString('base64'));
    } else {
      return back({ err: 'Upload a PDF or paste a Google Form link.' });
    }

    if (imported.field_schema.length === 0) {
      return back({ err: 'We couldn’t find any fields in that form. Try a clearer PDF, or build it from scratch.' });
    }

    // Dedupe the slug against this school's existing forms.
    const slugBase = imported.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'imported-form';
    const { rows: existing } = await query<{ slug: string }>(
      `SELECT slug FROM portal_form_definitions WHERE school_id = $1`, [school.id]);
    const have = new Set(existing.map((r) => r.slug));
    let slug = slugBase;
    for (let n = 2; have.has(slug); n++) slug = `${slugBase}-${n}`;

    const { rows: ins } = await query<{ id: string }>(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          field_schema, is_active, resubmission_allowed)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, true)
       RETURNING id`,
      [school.id, slug, imported.name, 'Imported — review the fields, then publish.',
       imported.category, true, JSON.stringify(imported.field_schema)],
    );

    // Into the builder — draft until the school publishes it.
    return NextResponse.redirect(
      new URL(`/school/${locationId}/forms/${ins[0].id}/builder?imported=1`, request.nextUrl), 303);
  } catch (err) {
    return back({ err: err instanceof Error ? err.message : 'Import failed.' });
  }
}
