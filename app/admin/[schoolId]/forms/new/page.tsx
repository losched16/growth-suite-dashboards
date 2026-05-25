// /admin/[schoolId]/forms/new — create a brand-new form.
//
// Lightweight: operator picks slug + display name + per-student flag +
// optional starter template. We insert a row in portal_form_definitions
// with a sensible default field_schema (header + signature blocks) and
// redirect to the editor for further customization.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ArrowLeft } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { NewFormForm } from './NewFormForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function NewFormPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId } = await params;

  const { rows: schoolRows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId],
  );
  if (schoolRows.length === 0) notFound();
  const school = schoolRows[0];

  // Pull existing slugs so the form can pre-validate duplicates client-side
  const { rows: existingSlugs } = await query<{ slug: string }>(
    `SELECT slug FROM portal_form_definitions WHERE school_id = $1`,
    [schoolId],
  );

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 dark:bg-black">
      <div className="w-full max-w-2xl space-y-4">
        <Link href={`/admin/${schoolId}/forms`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> Back to forms
        </Link>
        <header>
          <h1 className="text-2xl font-semibold text-zinc-900">Create a new form</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Pick a few essentials. You&rsquo;ll add the fields on the next screen.
          </p>
        </header>
        <NewFormForm
          schoolId={schoolId}
          existingSlugs={existingSlugs.map((s) => s.slug)}
        />
      </div>
    </main>
  );
}
