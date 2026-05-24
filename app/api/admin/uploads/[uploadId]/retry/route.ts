// Retry the GHL push for a single upload. Runs synchronously so the
// operator gets immediate feedback in the redirect message.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { uploadMediaToGhl } from '@/lib/ghl/media';
import { sendMessage } from '@/lib/ghl/conversations';

type Params = Promise<{ uploadId: string }>;

interface UploadRow {
  id: string;
  school_id: string;
  family_id: string;
  parent_id: string | null;
  student_id: string | null;
  display_name: string;
  original_filename: string;
  mime_type: string;
  notes: string | null;
  contents: Buffer;
  ghl_synced_at: Date | null;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { uploadId } = await params;
  try {
    const { rows } = await query<UploadRow>(
      `SELECT id, school_id, family_id, parent_id, student_id, display_name,
              original_filename, mime_type, notes, contents, ghl_synced_at
       FROM parent_uploads WHERE id = $1`,
      [uploadId],
    );
    if (rows.length === 0) return back(request, null, { err: 'Upload not found' });
    const u = rows[0];
    const schoolId = u.school_id;

    if (u.ghl_synced_at) {
      return back(request, schoolId, { msg: 'Already synced to GHL. Skipping.' });
    }

    // Look up parent contact (fall back to family's primary if needed)
    let contactId: string | null = null;
    if (u.parent_id) {
      const r = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents WHERE id = $1`,
        [u.parent_id],
      );
      contactId = r.rows[0]?.ghl_contact_id ?? null;
    }
    if (!contactId) {
      const r = await query<{ ghl_contact_id: string | null }>(
        `SELECT ghl_contact_id FROM parents
         WHERE family_id = $1 AND is_primary = true AND ghl_contact_id IS NOT NULL
         LIMIT 1`,
        [u.family_id],
      );
      contactId = r.rows[0]?.ghl_contact_id ?? null;
    }
    if (!contactId) {
      const errMsg = 'Family has no GHL contact id — cannot attach upload to a conversation';
      await query(`UPDATE parent_uploads SET ghl_sync_error = $1 WHERE id = $2`, [errMsg, uploadId]);
      return back(request, schoolId, { err: errMsg });
    }

    // Student name (best-effort)
    let studentName = '';
    if (u.student_id) {
      const r = await query<{ first_name: string; last_name: string; preferred_name: string | null }>(
        `SELECT first_name, last_name, preferred_name FROM students WHERE id = $1`,
        [u.student_id],
      );
      if (r.rows[0]) studentName = ` for ${r.rows[0].preferred_name || r.rows[0].first_name} ${r.rows[0].last_name}`;
    }

    const client = await loadGhlClient(schoolId);
    const media = await uploadMediaToGhl(client, {
      filename: u.original_filename,
      mimeType: u.mime_type,
      contents: u.contents,
    });
    const msg = await sendMessage(client, {
      contactId,
      body: `📎 Parent uploaded document: ${u.display_name}${studentName}.${u.notes ? `\n\nNotes: ${u.notes}` : ''}`,
      type: 'Live_Chat',
      attachments: [media.url],
    });

    await query(
      `UPDATE parent_uploads
       SET ghl_media_id = $1, ghl_media_url = $2,
           ghl_conversation_id = $3, ghl_message_id = $4,
           ghl_synced_at = now(), ghl_sync_error = NULL
       WHERE id = $5`,
      [media.fileId, media.url, msg.conversationId, msg.messageId, uploadId],
    );

    return back(request, schoolId, { msg: `Synced "${u.display_name}" to GHL.` });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await query(`UPDATE parent_uploads SET ghl_sync_error = $1 WHERE id = $2`, [errMsg.slice(0, 500), uploadId]).catch(() => undefined);
    return back(request, null, { err: `Retry failed: ${errMsg}` });
  }
}

function back(request: NextRequest, schoolId: string | null, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = schoolId ? `/admin/${schoolId}/uploads` : '/admin';
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  return NextResponse.redirect(url, 303);
}
