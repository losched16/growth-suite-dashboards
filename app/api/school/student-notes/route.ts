// Internal student notes feed (migration 099) — staff-only, never
// surfaced in the parent portal.
//
// GET  ?student_id=…               → chronological notes (newest first)
// POST {student_id, body}          → add a note (author = session identity)
// DELETE ?id=…                     → remove a note (author or operator)
//
// Auth: operator session or school session. GET also accepts the
// per-school embed token (read-only contexts inside the CRM iframe);
// WRITES always need an identified session so every note has an author.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';

export const dynamic = 'force-dynamic';

interface Viewer {
  school_id: string | null;      // null = operator (any school)
  author_email: string;
  author_name: string;
  is_operator: boolean;
}

async function identify(): Promise<Viewer | null> {
  const ck = await cookies();
  if (verifySessionToken(ck.get(SESSION_COOKIE)?.value)) {
    return { school_id: null, author_email: 'operator@growthsuite', author_name: 'Growth Suite', is_operator: true };
  }
  const ss = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (ss) {
    return {
      school_id: ss.school_id,
      author_email: (ss.user_email ?? '').toLowerCase(),
      author_name: ss.user_name || ss.user_email || 'Staff',
      is_operator: false,
    };
  }
  return null;
}

// Resolve the student and enforce school scoping for the viewer.
async function loadStudent(studentId: string): Promise<{ id: string; school_id: string; ghl_location_id: string } | null> {
  const { rows } = await query<{ id: string; school_id: string; ghl_location_id: string }>(
    `SELECT s.id, s.school_id, sc.ghl_location_id
       FROM students s JOIN schools sc ON sc.id = s.school_id
      WHERE s.id = $1`,
    [studentId],
  );
  return rows[0] ?? null;
}

export async function GET(request: NextRequest) {
  const studentId = (request.nextUrl.searchParams.get('student_id') ?? '').trim();
  if (!studentId) return NextResponse.json({ error: 'student_id required' }, { status: 400 });
  const student = await loadStudent(studentId);
  if (!student) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const viewer = await identify();
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  const embedOk = embedToken ? checkEmbedToken(student.ghl_location_id, embedToken) : false;
  if (!viewer && !embedOk) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (viewer && !viewer.is_operator && viewer.school_id !== student.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { rows } = await query<{ id: string; author_email: string; author_name: string; body: string; created_at: string }>(
    `SELECT id, author_email, author_name, body, created_at
       FROM student_notes
      WHERE school_id = $1 AND student_id = $2
      ORDER BY created_at DESC LIMIT 200`,
    [student.school_id, studentId],
  );
  // can_post tells the client whether to show the composer (embed-token
  // viewers without a session can read but not write).
  return NextResponse.json({ notes: rows, can_post: !!viewer, viewer_email: viewer?.author_email ?? null });
}

export async function POST(request: NextRequest) {
  const viewer = await identify();
  if (!viewer) {
    return NextResponse.json({
      error: 'unauthorized',
      detail: 'Notes need a signed-in staff session so each note has an author.',
    }, { status: 401 });
  }
  let body: { student_id?: unknown; body?: unknown } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const studentId = String(body.student_id ?? '').trim();
  const text = String(body.body ?? '').trim();
  if (!studentId || !text) return NextResponse.json({ error: 'student_id and body required' }, { status: 400 });
  if (text.length > 4000) return NextResponse.json({ error: 'note too long (4000 max)' }, { status: 400 });

  const student = await loadStudent(studentId);
  if (!student) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!viewer.is_operator && viewer.school_id !== student.school_id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { rows } = await query<{ id: string; created_at: string }>(
    `INSERT INTO student_notes (school_id, student_id, author_email, author_name, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [student.school_id, studentId, viewer.author_email, viewer.author_name, text],
  );
  return NextResponse.json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
}

export async function DELETE(request: NextRequest) {
  const viewer = await identify();
  if (!viewer) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = (request.nextUrl.searchParams.get('id') ?? '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { rows } = await query<{ id: string; school_id: string; author_email: string }>(
    `SELECT id, school_id, author_email FROM student_notes WHERE id = $1`, [id]);
  const note = rows[0];
  if (!note) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!viewer.is_operator) {
    if (viewer.school_id !== note.school_id) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    if (note.author_email !== viewer.author_email) {
      return NextResponse.json({ error: 'forbidden', detail: 'Only the author can delete a note.' }, { status: 403 });
    }
  }
  await query(`DELETE FROM student_notes WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
