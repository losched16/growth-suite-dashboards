// /admin/[schoolId]/financial-aid/settings — operator config for the
// multi-tenant FA platform. Toggles the school on/off, sets the
// active year, deadline, required documents, etc.

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, HandCoins } from 'lucide-react';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { query } from '@/lib/db';
import { getFinancialAidSettings, FA_DOCUMENT_CATALOG } from '@/lib/financial-aid/settings';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

type Params = Promise<{ schoolId: string }>;

export default async function FaSettingsPage({ params }: { params: Params }) {
  const ck = await cookies();
  if (!verifySessionToken(ck.get(SESSION_COOKIE)?.value)) redirect('/login');
  const { schoolId } = await params;

  const { rows: school } = await query<{ id: string; name: string; ghl_location_id: string }>(
    `SELECT id, name, ghl_location_id FROM schools WHERE id = $1`, [schoolId],
  );
  if (school.length === 0) notFound();

  const settings = await getFinancialAidSettings(schoolId);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <Link href={`/admin/${schoolId}`} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 mb-3">
          <ArrowLeft className="h-3 w-3" /> {school[0].name}
        </Link>

        <div className="flex items-center gap-2 mb-4">
          <HandCoins className="h-6 w-6 text-emerald-600" />
          <h1 className="text-2xl font-semibold text-slate-900">Financial Aid — Settings</h1>
        </div>
        <p className="text-sm text-slate-600 mb-6 max-w-2xl">
          Per-school config for the FA platform. When <strong>enabled</strong>, parents see the Financial Aid
          tab in their portal. When disabled, the section is hidden entirely from parents and the admin queue
          shows a &ldquo;FA disabled&rdquo; state.
        </p>

        <SettingsForm
          schoolId={schoolId}
          locationId={school[0].ghl_location_id}
          schoolName={school[0].name}
          initial={settings}
          documentCatalog={FA_DOCUMENT_CATALOG}
        />
      </div>
    </main>
  );
}
