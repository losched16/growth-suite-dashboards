// GHL Media library upload — operator-side copy of the parent portal's
// helper. Stays in lock-step with growth-suite-parent-portal/lib/ghl/media.ts.

import FormData from 'form-data';
import type { GhlClient } from './client';

export interface UploadedMedia {
  fileId: string;
  url: string;
}

export async function uploadMediaToGhl(
  client: GhlClient,
  opts: { filename: string; mimeType: string; contents: Buffer },
): Promise<UploadedMedia> {
  const fd = new FormData();
  fd.append('file', opts.contents, {
    filename: opts.filename,
    contentType: opts.mimeType,
  });
  fd.append('name', opts.filename);
  fd.append('hosted', 'false');
  fd.append('parentId', '');

  const { data } = await client.axios.post<{ fileId: string; url: string }>(
    '/medias/upload-file',
    fd,
    { headers: { ...fd.getHeaders() } },
  );
  if (!data.fileId || !data.url) {
    throw new Error('GHL media upload returned without fileId / url');
  }
  return { fileId: data.fileId, url: data.url };
}
