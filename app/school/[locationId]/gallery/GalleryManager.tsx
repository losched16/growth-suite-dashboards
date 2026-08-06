'use client';

// Client uploader for the website photo gallery. Handles: create album,
// drag-drop / pick photos (resized in-browser to full<=1600px + thumb<=500px
// JPEG before upload, so DB rows stay small and uploads stay fast),
// publish toggle, set cover, delete photo/album.

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Images, Upload, Trash2, Star, Eye, EyeOff, Plus, Loader2, ExternalLink } from 'lucide-react';

export interface AdminPhoto { id: string; caption: string | null }
export interface AdminAlbum {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  is_published: boolean;
  cover_photo_id: string | null;
  photos: AdminPhoto[];
}

const FULL_EDGE = 1600;
const FULL_Q = 0.82;
const THUMB_EDGE = 500;
const THUMB_Q = 0.8;

function adminImg(id: string, size: 'thumb' | 'full' = 'thumb') {
  return `/api/school/gallery/photo/${id}/image?size=${size}`;
}

// Resize an image File to a JPEG Blob whose longest edge is <= maxEdge.
async function resize(file: File, maxEdge: number, quality: number):
  Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unsupported');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality),
  );
  return { blob, width, height };
}

export function GalleryManager({ locationId, initialAlbums }:
  { locationId: string; initialAlbums: AdminAlbum[] }) {
  const [albums, setAlbums] = useState<AdminAlbum[]>(initialAlbums);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<Record<string, { done: number; total: number }>>({});
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const publicFeed = `/api/website/gallery/${locationId}`;

  const flash = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); }, []);

  async function createAlbum(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const t = title.trim();
    if (!t) { setErr('Give the album a name.'); return; }
    setCreating(true);
    try {
      const r = await fetch('/api/school/gallery/album', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, description: description.trim() || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not create album.');
      setAlbums((a) => [...a, { ...data.album, photos: [] }]);
      setTitle(''); setDescription('');
      setExpanded((x) => ({ ...x, [data.album.id]: true }));
      flash('Album created — add some photos.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally { setCreating(false); }
  }

  async function uploadFiles(albumId: string, files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) { setErr('Please choose image files.'); return; }
    setErr(null);
    setUploading((u) => ({ ...u, [albumId]: { done: 0, total: list.length } }));
    let added = 0;
    for (const file of list) {
      try {
        const [full, thumb] = await Promise.all([
          resize(file, FULL_EDGE, FULL_Q),
          resize(file, THUMB_EDGE, THUMB_Q),
        ]);
        const fd = new FormData();
        fd.append('full', full.blob, 'full.jpg');
        fd.append('thumb', thumb.blob, 'thumb.jpg');
        fd.append('width', String(full.width));
        fd.append('height', String(full.height));
        fd.append('thumb_width', String(thumb.width));
        fd.append('thumb_height', String(thumb.height));
        const r = await fetch(`/api/school/gallery/album/${albumId}/photo`, { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'upload failed');
        const newId: string = data.photo.id;
        setAlbums((a) => a.map((al) => al.id === albumId
          ? {
              ...al,
              photos: [...al.photos, { id: newId, caption: null }],
              cover_photo_id: al.cover_photo_id ?? newId,
            }
          : al));
        added++;
      } catch {
        // keep going; report at the end
      }
      setUploading((u) => ({ ...u, [albumId]: { done: (u[albumId]?.done ?? 0) + 1, total: list.length } }));
    }
    setUploading((u) => { const n = { ...u }; delete n[albumId]; return n; });
    if (added === list.length) flash(`Added ${added} photo${added === 1 ? '' : 's'}.`);
    else setErr(`Added ${added} of ${list.length}. Some images couldn't be read (HEIC and other formats may not be supported — try JPEG or PNG).`);
  }

  async function patchAlbum(albumId: string, patch: Record<string, unknown>) {
    const r = await fetch(`/api/school/gallery/album/${albumId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!r.ok) { setErr('Update failed.'); return false; }
    return true;
  }

  async function togglePublish(al: AdminAlbum) {
    const next = !al.is_published;
    if (await patchAlbum(al.id, { is_published: next })) {
      setAlbums((a) => a.map((x) => x.id === al.id ? { ...x, is_published: next } : x));
      flash(next ? 'Album is live on the website.' : 'Album hidden from the website.');
    }
  }

  async function setCover(albumId: string, photoId: string) {
    if (await patchAlbum(albumId, { cover_photo_id: photoId })) {
      setAlbums((a) => a.map((x) => x.id === albumId ? { ...x, cover_photo_id: photoId } : x));
      flash('Cover updated.');
    }
  }

  async function deleteAlbum(al: AdminAlbum) {
    if (!confirm(`Delete the album “${al.title}” and its ${al.photos.length} photo(s)? This can't be undone.`)) return;
    const r = await fetch(`/api/school/gallery/album/${al.id}`, { method: 'DELETE' });
    if (!r.ok) { setErr('Delete failed.'); return; }
    setAlbums((a) => a.filter((x) => x.id !== al.id));
    flash('Album deleted.');
  }

  async function deletePhoto(albumId: string, photoId: string) {
    const r = await fetch(`/api/school/gallery/photo/${photoId}`, { method: 'DELETE' });
    if (!r.ok) { setErr('Delete failed.'); return; }
    setAlbums((a) => a.map((al) => al.id === albumId
      ? { ...al, photos: al.photos.filter((p) => p.id !== photoId), cover_photo_id: al.cover_photo_id === photoId ? (al.photos.find((p) => p.id !== photoId)?.id ?? null) : al.cover_photo_id }
      : al));
  }

  return (
    <div className="space-y-6">
      {msg ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
      {err ? <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div> : null}

      {/* Create album */}
      <section className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
          <Plus className="h-4 w-4" /> New album
        </h2>
        <form onSubmit={createAlbum} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Album name *</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120}
                placeholder='e.g. "Fall Festival 2026"'
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-gray-700">Short description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
                placeholder="One line shown under the album title"
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm" />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={creating}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Create album
            </button>
          </div>
        </form>
      </section>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{albums.length} album{albums.length === 1 ? '' : 's'}</span>
        <a href={publicFeed} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-gray-500 hover:text-emerald-700">
          <ExternalLink className="h-3 w-3" /> Preview website feed
        </a>
      </div>

      {albums.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
          <Images className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900">No albums yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">Create your first album above, then drag in photos.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {albums.map((al) => {
            const cover = al.cover_photo_id ?? al.photos[0]?.id ?? null;
            const up = uploading[al.id];
            const isOpen = !!expanded[al.id];
            return (
              <li key={al.id} className="rounded-lg border border-gray-200 bg-white">
                <div className="flex items-start gap-4 p-4">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-gray-100">
                    {cover
                      ? <img src={adminImg(cover)} alt="" className="h-full w-full object-cover" />
                      : <div className="flex h-full w-full items-center justify-center text-gray-300"><Images className="h-6 w-6" /></div>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-gray-900">{al.title}</h3>
                      {al.is_published
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Live</span>
                        : <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Hidden</span>}
                    </div>
                    {al.description ? <p className="mt-0.5 truncate text-xs text-gray-500">{al.description}</p> : null}
                    <p className="mt-0.5 text-xs text-gray-500">{al.photos.length} photo{al.photos.length === 1 ? '' : 's'}</p>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input ref={(el) => { fileInputs.current[al.id] = el; }} type="file" accept="image/*" multiple hidden
                        onChange={(e) => { if (e.target.files?.length) uploadFiles(al.id, e.target.files); e.target.value = ''; }} />
                      <button onClick={() => fileInputs.current[al.id]?.click()} disabled={!!up}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                        {up ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {up ? `Uploading ${up.done}/${up.total}…` : 'Add photos'}
                      </button>
                      <button onClick={() => togglePublish(al)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
                        {al.is_published ? <><EyeOff className="h-3.5 w-3.5" /> Hide</> : <><Eye className="h-3.5 w-3.5" /> Publish</>}
                      </button>
                      {al.photos.length > 0 ? (
                        <button onClick={() => setExpanded((x) => ({ ...x, [al.id]: !isOpen }))}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
                          {isOpen ? 'Hide photos' : `Manage photos (${al.photos.length})`}
                        </button>
                      ) : null}
                      <button onClick={() => deleteAlbum(al)}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </div>
                </div>

                {isOpen && al.photos.length > 0 ? (
                  <div className="border-t border-gray-100 p-4">
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
                      {al.photos.map((p) => (
                        <div key={p.id} className="group relative aspect-square overflow-hidden rounded-md bg-gray-100">
                          <img src={adminImg(p.id)} alt={p.caption ?? ''} className="h-full w-full object-cover" />
                          <div className="absolute inset-0 flex items-start justify-between p-1 opacity-0 transition group-hover:opacity-100">
                            <button title="Set as album cover" onClick={() => setCover(al.id, p.id)}
                              className={`rounded p-1 ${al.cover_photo_id === p.id ? 'bg-amber-400 text-white' : 'bg-black/55 text-white hover:bg-black/75'}`}>
                              <Star className="h-3.5 w-3.5" />
                            </button>
                            <button title="Delete photo" onClick={() => deletePhoto(al.id, p.id)}
                              className="rounded bg-black/55 p-1 text-white hover:bg-rose-600">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {al.cover_photo_id === p.id ? (
                            <span className="absolute bottom-1 left-1 rounded bg-amber-400/95 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">Cover</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
