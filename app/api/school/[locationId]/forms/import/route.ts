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
const MAX_BATCH = 8; // parsed in parallel; keeps the whole batch inside maxDuration

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
  const pdfs = form.getAll('pdf')
    .filter((f): f is File => f != null && typeof f === 'object' && 'arrayBuffer' in f && (f as File).size > 0);

  // Existing slugs, tracked so multiple imports in one batch don't collide.
  const have = new Set<string>();
  async function loadExistingSlugs() {
    const { rows } = await query<{ slug: string }>(
      `SELECT slug FROM portal_form_definitions WHERE school_id = $1`, [school!.id]);
    for (const r of rows) have.add(r.slug);
  }
  async function createDraft(imported: ImportedForm): Promise<string> {
    const base = imported.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'imported-form';
    let slug = base;
    for (let n = 2; have.has(slug); n++) slug = `${base}-${n}`;
    have.add(slug);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO portal_form_definitions
         (school_id, slug, display_name, description, category, per_student,
          field_schema, is_active, resubmission_allowed)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, false, true)
       RETURNING id`,
      [school!.id, slug, imported.name, 'Imported — review the fields, then publish.',
       imported.category, true, JSON.stringify(imported.field_schema)],
    );
    return rows[0].id;
  }

  try {
    // ── Single Google Form ──
    if (googleUrl) {
      if (!/^https?:\/\/(docs\.google\.com|forms\.gle)\//i.test(googleUrl)) {
        return back({ err: 'That doesn’t look like a Google Form link (expected docs.google.com/forms/… or forms.gle/…).' });
      }
      const imported = await parseFormFromGoogleForm(googleUrl);
      if (imported.field_schema.length === 0) {
        return back({ err: 'We couldn’t find any fields in that Google Form. Make sure it’s shared publicly.' });
      }
      await loadExistingSlugs();
      const id = await createDraft(imported);
      return NextResponse.redirect(new URL(`/school/${locationId}/forms/${id}/builder?imported=1`, request.nextUrl), 303);
    }

    // ── One or more PDFs (batch) ──
    if (pdfs.length === 0) return back({ err: 'Upload a PDF or paste a Google Form link.' });
    if (pdfs.length > MAX_BATCH) {
      return back({ err: `Please import at most ${MAX_BATCH} PDFs at a time (you selected ${pdfs.length}).` });
    }
    for (const f of pdfs) {
      if (f.type && f.type !== 'application/pdf') return back({ err: `“${f.name}” isn’t a PDF. Upload PDFs only, or paste a Google Form link.` });
      if (f.size > MAX_PDF_BYTES) return back({ err: `“${f.name}” is too large (max 12 MB each).` });
    }

    // Parse all in parallel (each ~30s; concurrency keeps the whole batch inside maxDuration).
    const parsed = await Promise.allSettled(pdfs.map(async (f) => {
      const bytes = await f.arrayBuffer();
      const imported = await parseFormFromPdf(Buffer.from(bytes).toString('base64'));
      return { name: f.name, imported };
    }));

    await loadExistingSlugs();
    const createdIds: string[] = [];
    const failures: string[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      const fname = pdfs[i].name;
      if (p.status === 'fulfilled' && p.value.imported.field_schema.length > 0) {
        createdIds.push(await createDraft(p.value.imported));
      } else {
        failures.push(fname);
      }
    }

    if (createdIds.length === 0) {
      return back({ err: 'None of the PDFs could be imported. Try clearer PDFs, or build from scratch.' });
    }
    // A single successful import → straight into its builder.
    if (createdIds.length === 1 && failures.length === 0) {
      return NextResponse.redirect(new URL(`/school/${locationId}/forms/${createdIds[0]}/builder?imported=1`, request.nextUrl), 303);
    }
    // A real batch → back to the forms list with a summary (each is a draft to review).
    const msg = `Imported ${createdIds.length} form${createdIds.length === 1 ? '' : 's'} as drafts — review + publish each.${failures.length ? ` Couldn’t read: ${failures.join(', ')}.` : ''}`;
    const url = new URL(`/school/${locationId}/forms`, request.nextUrl);
    url.searchParams.set('msg', msg);
    return NextResponse.redirect(url, 303);
  } catch (err) {
    return back({ err: err instanceof Error ? err.message : 'Import failed.' });
  }
}
