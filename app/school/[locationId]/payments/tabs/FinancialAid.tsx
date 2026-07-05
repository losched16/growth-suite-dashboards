// Financial Aid tab — school-facing FA policy + settings.
//
// Reuses the operator SettingsForm client component (a school session can
// now save its own FA settings — the settings route is dual-auth). Lets a
// school turn FA on/off, set its policy, required documents, award caps,
// COL context, decision-letter template, and the parent-facing intro —
// all self-serve, no operator involvement.

import { getFinancialAidSettings, FA_DOCUMENT_CATALOG } from '@/lib/financial-aid/settings';
import { SettingsForm } from '@/app/admin/[schoolId]/financial-aid/settings/SettingsForm';

export async function PaymentsHubFinancialAid({
  schoolId, locationId, schoolName,
}: { schoolId: string; locationId: string; schoolName: string }) {
  const settings = await getFinancialAidSettings(schoolId);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Financial Aid</h2>
        <p className="text-sm text-slate-500">
          Turn financial aid on or off and set your own policy — required documents, award caps,
          cost-of-living context, decision letter, and the intro parents read. Changes apply to your
          parent portal immediately.
        </p>
      </div>

      <SettingsForm
        schoolId={schoolId}
        locationId={locationId}
        schoolName={schoolName}
        initial={settings}
        documentCatalog={FA_DOCUMENT_CATALOG}
      />
    </div>
  );
}
