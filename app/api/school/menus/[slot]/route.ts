// POST /api/school/menus/[slot]
//   Upload a new menu image for the given slot. Replaces any existing
//   asset (latest write wins — old version is discarded).
//
// DELETE /api/school/menus/[slot]
//   Drop the current asset back to the static /public fallback.
//
// Auth: valid school session + editor's email (from the teacher cookie)
//       must be on the school_menu_editors allowlist.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getTeacherIdentity } from '@/lib/auth/teacher-identity';
import { isValidSlot, isMenuEditor } from '@/lib/menus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ slot: string }>;

const MAX_BYTES = 15 * 1024 * 1024; // 15MB — matches table CHECK

type AuthResult =
  | { ok: false; status: 400 | 401 | 403; body: { error: string; detail?: string } }
  | { ok: true; session: { school_id: string }; teacher: { email: string; name: string | null } };

async function authorize(slot: string): Promise<AuthResult> {
  if (!isValidSlot(slot)) return { ok: false, status: 400, body: { error: 'bad_slot' } };
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return { ok: false, status: 401, body: { error: 'unauthorized' } };
  const teacher = await getTeacherIdentity();
  if (!teacher) {
    return { ok: false, status: 403, body: { error: 'identify_first', detail: 'Pick your name on the staff-requests landing first so we know who is uploading.' } };
  }
  const editor = await isMenuEditor(session.school_id, teacher.email);
  if (!editor) {
    return { ok: false, status: 403, body: { error: 'not_a_menu_editor', detail: `${teacher.email} is not on the menu editor allowlist for this school.` } };
  }
  return { ok: true, session, teacher };
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { slot } = await params;
  const auth = await authorize(slot);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const { session, teacher } = auth;

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({
      error: 'file_too_large',
      detail: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is 15MB.`,
    }, { status: 413 });
  }
  const displayLabel = String(fd.get('display_label') ?? '').trim() || null;

  const buf = Buffer.from(await file.arrayBuffer());

  // ON CONFLICT (school_id, slot) DO UPDATE — atomic replace.
  await query(
    `INSERT INTO school_menu_assets
       (school_id, slot, display_label, original_filename, mime_type, size_bytes, contents, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (school_id, slot) DO UPDATE
       SET display_label     = EXCLUDED.display_label,
           original_filename = EXCLUDED.original_filename,
           mime_type         = EXCLUDED.mime_type,
           size_bytes        = EXCLUDED.size_bytes,
           contents          = EXCLUDED.contents,
           uploaded_by       = EXCLUDED.uploaded_by,
           uploaded_at       = now()`,
    [session.school_id, slot, displayLabel, file.name, file.type || 'image/png', file.size, buf, teacher.email],
  );

  return NextResponse.json({ ok: true, slot, uploaded_at: new Date().toISOString() });
}

export async function DELETE(_request: NextRequest, { params }: { params: Params }) {
  const { slot } = await params;
  const auth = await authorize(slot);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const { session } = auth;

  await query(
    `DELETE FROM school_menu_assets WHERE school_id = $1 AND slot = $2`,
    [session.school_id, slot],
  );
  return NextResponse.json({ ok: true, slot, reverted_to_fallback: true });
}
