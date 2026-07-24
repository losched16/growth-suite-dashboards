// Payments → Add-ons tab. Server wrapper that loads the school's add-on
// rate card and hands it to the client editor. The rate card feeds the
// "Enroll a family" builder's extended-care / deposit / dev-fee pickers.

import { loadAddonCatalog } from '@/lib/billing/addon-catalog';
import { AddonCatalogEditor } from './AddonCatalogEditor';

export async function PaymentsHubAddons({
  schoolId, locationId,
}: { schoolId: string; locationId: string }) {
  const catalog = await loadAddonCatalog(schoolId);
  return <AddonCatalogEditor schoolId={schoolId} locationId={locationId} catalog={catalog} />;
}
