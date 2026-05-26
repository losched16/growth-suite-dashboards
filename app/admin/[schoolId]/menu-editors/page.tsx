// /admin/[schoolId]/menu-editors
//
// Operator-facing CRUD for the menu editor allowlist. Add an email
// here and that person can upload new menu images on the school's
// /menus/edit page. Remove them and they're back to read-only.

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Trash2, Plus, UserCircle, Image as ImageIcon } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { EditorListClient } from './EditorListClient';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

interface Editor { id: string; email: string; name: string | null; created_at: string }

export default async function MenuEditorsPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId } = await params;

  const schoolRes = await query<{ id: string; name: string; ghl_location_id: string }>(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`,
    [schoolId],
  );
  if (schoolRes.rows.length === 0) notFound();
  const school = schoolRes.rows[0];

  const { rows: editorsRaw } = await query<Editor>(
    `SELECT id, email, name, created_at::text FROM school_menu_editors
      WHERE school_id = $1 ORDER BY created_at`,
    [schoolId],
  );

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <Link href={`/admin/${schoolId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-3">
          <ArrowLeft className="h-3 w-3" /> {school.name}
        </Link>

        <div className="flex items-center gap-2 mb-4">
          <ImageIcon className="h-6 w-6 text-blue-600" />
          <h1 className="text-2xl font-semibold text-slate-900">Menu editors</h1>
        </div>
        <p className="text-sm text-slate-600 mb-6">
          People on this list can upload new menu images (lunch calendar, snack menu,
          Harvest of the Month) for <strong>{school.name}</strong>. Everyone else on
          staff sees the menus but can&rsquo;t edit them. Add or remove freely &mdash;
          no redeploy needed.
        </p>

        <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 inline-flex items-center gap-1">
            <Plus className="h-4 w-4" /> Add an editor
          </h2>
          <EditorListClient schoolId={schoolId} initialEditors={editorsRaw} />
          <p className="text-[11px] text-slate-500 italic">
            The email must match the address the editor uses when they pick their
            name on the staff-requests landing (where the &ldquo;teacher identity&rdquo;
            cookie is set). Case is ignored.
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600">
          <p className="font-semibold text-slate-800 mb-1">Direct edit URL (for the editor to bookmark):</p>
          <code className="block break-all bg-slate-50 rounded px-2 py-1 text-[11px]">
            /school/{school.ghl_location_id}/menus/edit?chrome=none
          </code>
        </div>
      </div>
    </main>
  );
}

// keep the linter happy — Trash2 / UserCircle are used by the client
void Trash2; void UserCircle;
