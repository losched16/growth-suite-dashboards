// CSV serializer + auth + response helpers used by all /api/export/* routes.
//
// Auth: accepts either an active gsd_school_session cookie (set by the
// proxy after embed-token-redirect) OR an explicit `embed_token` query
// param. The route is mounted outside the proxy guard (see proxy.ts
// matcher) and validates auth itself.

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { checkEmbedToken } from '@/lib/auth/embed';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';

export interface AuthorizedSchool {
  id: string;
  name: string;
  ghl_location_id: string;
}

// Resolve auth: returns the school row if either cookie or embed_token is valid.
export async function authorizeExport(
  request: NextRequest,
  locationId: string,
): Promise<AuthorizedSchool | null> {
  // 1. Try session cookie
  const sessionToken = request.cookies.get(SCHOOL_SESSION_COOKIE)?.value;
  const session = await verifySchoolSession(sessionToken);
  if (session && session.ghl_location_id === locationId) {
    const school = await loadSchoolByLocationId(locationId);
    if (school) return { id: school.id, name: school.name, ghl_location_id: school.ghl_location_id };
  }

  // 2. Try embed_token
  const embedToken = request.nextUrl.searchParams.get('embed_token');
  if (embedToken && checkEmbedToken(locationId, embedToken)) {
    const school = await loadSchoolByLocationId(locationId);
    if (school) return { id: school.id, name: school.name, ghl_location_id: school.ghl_location_id };
  }

  return null;
}

// --- CSV serialization ----------------------------------------------------

export interface CsvColumn<T> {
  key: string;
  label: string;
  /** Custom value extractor. Defaults to (row as Record)[key] */
  value?: (row: T) => string | number | null | undefined;
}

function escape(v: unknown): string {
  if (v === null || v === undefined) return '';
  // Normalize Date / timestamp values to YYYY-MM-DD for Excel-friendly output.
  let s: string;
  if (v instanceof Date) {
    s = isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  } else {
    s = String(v);
    // Heuristic: full GMT timestamp from `pg` deserialization → strip to YYYY-MM-DD
    if (/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) s = d.toISOString().slice(0, 10);
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
      // ISO timestamp → strip time portion
      s = s.slice(0, 10);
    }
  }
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headers = columns.map((c) => escape(c.label)).join(',');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const val = c.value ? c.value(row) : (row as unknown as Record<string, unknown>)[c.key];
        return escape(val);
      })
      .join(','),
  );
  return [headers, ...lines].join('\r\n');
}

export function csvResponse(filename: string, csv: string): NextResponse {
  // Prepend BOM so Excel auto-detects UTF-8 correctly.
  const body = '﻿' + csv;
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\w. -]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

export function unauthorizedCsvResponse(): NextResponse {
  return new NextResponse('unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
}

export function notFoundCsvResponse(): NextResponse {
  return new NextResponse('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
