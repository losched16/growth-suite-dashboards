// POST /api/onboarding/upload-doc — a school uploads an intake file (roster
// CSV, logo, handbook) against a document task. Stored as bytea in
// onboarding_documents, same pattern as school_documents / FA docs. Token-authed.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { verifyOnboardingToken } from '@/lib/onboarding/token';
import { CHECKLIST_BY_KEY } from '@/lib/onboarding/checklist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

function back(request: NextRequest, token: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/onboarding/${token}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const fd = await request.formData();
  const token = String(fd.get('token') ?? '');
  const onboardingId = verifyOnboardingToken(token);
  if (!onboardingId) return new NextResponse('Link expired or invalid.', { status: 401 });

  const taskKey = String(fd.get('task_key') ?? '').trim();
  const task = CHECKLIST_BY_KEY[taskKey];
  if (!task || task.type !== 'document') {
    return back(request, token, { err: 'Unknown upload step.' });
  }

  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return back(request, token, { err: 'Pick a file to upload.' });
  }
  if (file.size > MAX_BYTES) {
    return back(request, token, { err: `File is too large (max ${Math.floor(MAX_BYTES / 1024 / 1024)} MB).` });
  }
  // MIME allow-list from the task definition. Client-declared type — we accept
  // it defensively (matches the FA upload path); ops reviews the file anyway.
  const mime = file.type || 'application/octet-stream';
  if (task.accept.length && !task.accept.includes(mime)) {
    return back(request, token, { err: `That file type isn't accepted here. Expected: ${task.accept.join(', ')}.` });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  await query(
    `INSERT INTO onboarding_documents
       (onboarding_id, task_key, title, original_filename, mime_type, size_bytes, contents, status, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', $8, now())`,
    [onboardingId, taskKey, task.title, file.name.slice(0, 255), mime, buf.length, buf, 'school'],
  );

  // Mark the task submitted so status shows in-progress until ops accepts it.
  await query(
    `INSERT INTO onboarding_task_state (onboarding_id, task_key, status, submitted_at, updated_at)
     VALUES ($1, $2, 'submitted', now(), now())
     ON CONFLICT (onboarding_id, task_key) DO UPDATE SET status = 'submitted', submitted_at = now(), updated_at = now()`,
    [onboardingId, taskKey],
  );

  return back(request, token, { msg: `Uploaded "${file.name}". We'll review it shortly.` });
}
