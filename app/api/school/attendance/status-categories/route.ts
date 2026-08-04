// Self-serve management of the school's custom attendance status
// categories (Attendance dashboard "Manage statuses" panel).
// POST {label, color} adds one; DELETE {key} removes one (existing
// daily_attendance rows keep the old key — they display the raw key and
// age out naturally, so no destructive cleanup here).

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import {
  MAX_CUSTOM_STATUSES, STATUS_COLORS,
  readCustomStatuses, writeCustomStatuses, slugifyStatusKey,
} from '@/lib/attendance/custom-statuses';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const body = await request.json().catch(() => ({}));
  const label = String(body.label ?? '').trim().slice(0, 24);
  const color = String(body.color ?? 'slate');
  if (!label) return new NextResponse('label required', { status: 400 });
  if (!(STATUS_COLORS as readonly string[]).includes(color)) {
    return new NextResponse('invalid color', { status: 400 });
  }
  const key = slugifyStatusKey(label);
  if (!key) return new NextResponse('label must contain letters or numbers', { status: 400 });

  const list = await readCustomStatuses(session.school_id);
  if (list.length >= MAX_CUSTOM_STATUSES) {
    return new NextResponse(`limit of ${MAX_CUSTOM_STATUSES} categories reached`, { status: 400 });
  }
  if (list.some((s) => s.key === key)) {
    return new NextResponse('a category with that name already exists', { status: 409 });
  }
  const next = [...list, { key, label, color }];
  await writeCustomStatuses(session.school_id, next);
  return NextResponse.json({ ok: true, statuses: next });
}

export async function DELETE(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return new NextResponse('unauthorized', { status: 401 });

  const body = await request.json().catch(() => ({}));
  const key = String(body.key ?? '').trim();
  if (!key) return new NextResponse('key required', { status: 400 });

  const list = await readCustomStatuses(session.school_id);
  const next = list.filter((s) => s.key !== key);
  if (next.length === list.length) return new NextResponse('not found', { status: 404 });
  await writeCustomStatuses(session.school_id, next);
  return NextResponse.json({ ok: true, statuses: next });
}
