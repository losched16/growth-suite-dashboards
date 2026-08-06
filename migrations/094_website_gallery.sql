-- 092_website_gallery.sql
--
-- Photo gallery for a school's PUBLIC MARKETING WEBSITE (e.g. FLMA's
-- flma-vercel site), managed from the Growth Suite school dashboard under
-- /school/{locationId}/gallery and read by the static site through the
-- public API at /api/website/gallery/{locationId}.
--
-- Images are stored as bytea in Postgres (same proven pattern as
-- school_documents, migration 049) — the dashboards app has no Supabase
-- Storage client configured, only DATABASE_URL. The admin uploader
-- resizes each photo in the browser before upload (full <= 1600px, thumb
-- <= 500px, JPEG), so rows stay small (typically 150-350 KB full,
-- 30-80 KB thumb). Curated school galleries fit comfortably; if a school
-- ever needs thousands of photos we migrate that school to object storage.
--
-- School-agnostic: keyed by school_id, so every school we onboard can use
-- the same manager + website widget with no per-school code.

CREATE TABLE IF NOT EXISTS website_gallery_albums (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  title          text NOT NULL,
  description    text,
  cover_photo_id uuid,              -- FK added after photos table exists
  position       integer NOT NULL DEFAULT 0,
  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, slug)
);

CREATE TABLE IF NOT EXISTS website_gallery_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id     uuid NOT NULL REFERENCES website_gallery_albums(id) ON DELETE CASCADE,
  school_id    uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  full_bytes   bytea NOT NULL,
  thumb_bytes  bytea NOT NULL,
  mime         text NOT NULL DEFAULT 'image/jpeg',
  width        integer,
  height       integer,
  thumb_width  integer,
  thumb_height integer,
  caption      text,
  size_bytes   integer NOT NULL DEFAULT 0,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Cover points at a photo; null it out if that photo is deleted so we
-- fall back to "first photo" rather than dangling.
ALTER TABLE website_gallery_albums
  DROP CONSTRAINT IF EXISTS website_gallery_albums_cover_fk;
ALTER TABLE website_gallery_albums
  ADD CONSTRAINT website_gallery_albums_cover_fk
  FOREIGN KEY (cover_photo_id) REFERENCES website_gallery_photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wg_albums_school ON website_gallery_albums (school_id, position, created_at);
CREATE INDEX IF NOT EXISTS idx_wg_photos_album ON website_gallery_photos (album_id, position, created_at);
