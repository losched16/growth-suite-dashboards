// POST /api/admin/schools/{schoolId}/shared-documents
//
// Upload a school-wide document for the parent portal, targeted with the
// notifications-style audience (include + optional exclude). Multipart:
//   file            the document (10MB cap)
//   title           display title
//   description?    optional context line
//   category?       handbook / calendar / forms / other
//   include         JSON Audience — who sees it (default: everyone)
//   exclude?        JSON Audience — who is carved out (optional)

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { sanitizeAudience, summarizeAudience } from '@/lib/notifications/audience';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

const MAX_BYTES = 10 * 1024 * 1024;

async function authorize(schoolId: string): Promise<{ ok: true; email: string | null } | { ok: false; status: 401 | 403 }> {
  const ck = await cookies();
  const op = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  if (op) return { ok: true, email: typeof op === 'object' && op && 'email' in op ? String((op as { email?: unknown }).email ?? '') || null : null };
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss && ss.school_id === schoolId) return { ok: true, email: null };
  return { ok: false, status: ss ? 403 : 401 };
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  const auth = await authorize(schoolId);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: auth.status });

  let fd: FormData;
  try { fd = await request.formData(); }
  catch { return NextResponse.json({ error: 'invalid_body' }, { status: 400 }); }

  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file_too_large', detail: 'Max 10 MB per file.' }, { status: 400 });
  }
  const title = String(fd.get('title') ?? '').trim().slice(0, 200);
  if (!title) return NextResponse.json({ error: 'missing_title' }, { status: 400 });
  const description = String(fd.get('description') ?? '').trim().slice(0, 1000) || null;
  const category = String(fd.get('category') ?? '').trim().slice(0, 40) || null;

  const include = sanitizeAudience(safeJson(fd.get('include')));
  if (!include) return NextResponse.json({ error: 'invalid_audience', detail: 'Pick who should see this document.' }, { status: 400 });
  // Exclude is optional — absent/invalid means nobody is carved out.
  const exclude = sanitizeAudience(safeJson(fd.get('exclude')));

  const label = summarizeAudience(include) + (exclude ? ` — except ${summarizeAudience(exclude)}` : '');

  const buf = Buffer.from(await file.arrayBuffer());
  const { rows } = await query<{ id: string }>(
    `INSERT INTO school_shared_documents
       (school_id, title, description, category, file_name, mime_type, size_bytes, file_bytes,
        include_audience, exclude_audience, audience_label, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
     RETURNING id`,
    [schoolId, title, description, category,
     file.name, file.type || 'application/octet-stream', buf.length, buf,
     JSON.stringify(include), exclude ? JSON.stringify(exclude) : null, label, auth.email],
  );
  return NextResponse.json({ ok: true, id: rows[0].id, audience_label: label });
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string' || !v.trim()) return null;
  try { return JSON.parse(v); } catch { return null; }
}
