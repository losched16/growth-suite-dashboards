// GET /api/website/documents/file/{id} — PUBLIC bytes for one website
// document. The marketing site links its download cards straight here.
//
// Only serves rows that are published, so unpublishing a document in the
// manager pulls it off the open web immediately. Bytes are immutable per
// id (a replacement is a new row), so we cache hard.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/** Keep a filename safe to put in a header: no quotes, no control chars,
 *  no path separators. */
function safeName(name: string): string {
  const clean = name.replace(/[\\/\u0000-\u001f"]/g, '').trim();
  return clean.slice(0, 120) || 'document';
}

export async function GET(_request: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'bad_id' }, { status: 400, headers: CORS });
  }

  const { rows } = await query<{
    contents: Buffer; mime_type: string; original_filename: string;
  }>(
    `SELECT contents, mime_type, original_filename
       FROM website_documents
      WHERE id = $1 AND is_published = true`,
    [id],
  );
  if (rows.length === 0 || !rows[0].contents) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CORS });
  }

  return new NextResponse(new Uint8Array(rows[0].contents), {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': rows[0].mime_type || 'application/octet-stream',
      // inline: a parent clicking a newsletter expects the PDF to open, not
      // to land in Downloads.
      'Content-Disposition': `inline; filename="${safeName(rows[0].original_filename)}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
