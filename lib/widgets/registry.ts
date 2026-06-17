// Central widget registry. Each widget is imported and added to the map
// here. New widgets = new file in `components/<Name>/` + add to this map.
//
// The registry is code-only (per brief §19 decisions) — no DB-driven
// definitions in v1.

import type { WidgetDefinition } from './types';
import { HelloWorldWidget } from './components/HelloWorldWidget';
import { FormCompletionGrid } from './components/FormCompletionGrid';
import { RecentFormSubmissions } from './components/RecentFormSubmissions';
import { FamilyListTable } from './components/FamilyListTable';
import { FamilyDetailCard } from './components/FamilyDetailCard';
import { StudentCardList } from './components/StudentCardList';
import { StudentRosterTable } from './components/StudentRosterTable';
import { EnrollmentByGradeChart } from './components/EnrollmentByGradeChart';
import { EnrollmentTargetsTable } from './components/EnrollmentTargetsTable';
import { RecentEnrollments } from './components/RecentEnrollments';
import { AdmissionsFunnelStages } from './components/AdmissionsFunnelStages';
import { PaymentDashboardPlaceholder } from './components/PaymentDashboardPlaceholder';
import { MarketingDashboardPlaceholder } from './components/MarketingDashboardPlaceholder';
import { EnrollmentHubTable } from './components/EnrollmentHubTable';
import { FamilyHubTable } from './components/FamilyHubTable';
import { StudentRosterRich } from './components/StudentRosterRich';
import { DocumentTracker } from './components/DocumentTracker';
import { RostersHub } from './components/RostersHub';
import { FinanceDashboard } from './components/FinanceDashboard';
import { DonorDashboard } from './components/DonorDashboard';
import { FinancialAidQueue } from './components/FinancialAidQueue';
import { AttendanceDashboard } from './components/AttendanceDashboard';
import { PortalFormsCompletionGrid } from './components/PortalFormsCompletionGrid';
import { PortalFormsTracker } from './components/PortalFormsTracker';
import { PortalFormsInbox } from './components/PortalFormsInbox';
import { PaymentsOverview } from './components/PaymentsOverview';
import { StudentDocumentsBrowser } from './components/StudentDocumentsBrowser';
import { ClassroomHotLunch } from './components/ClassroomHotLunch';
import { ClassroomParentContacts } from './components/ClassroomParentContacts';
import { ClassroomPickupRestrictions } from './components/ClassroomPickupRestrictions';
import { ClassroomAllergies } from './components/ClassroomAllergies';
import { StudentImmunizations } from './components/StudentImmunizations';

// Use unknown for the value type so widgets with different config/data
// shapes can coexist in one map. Lookups cast back at the use site.
export const widgetRegistry: Record<string, WidgetDefinition<unknown, unknown>> = {
  [HelloWorldWidget.id]: HelloWorldWidget as WidgetDefinition<unknown, unknown>,
  [FormCompletionGrid.id]: FormCompletionGrid as WidgetDefinition<unknown, unknown>,
  [RecentFormSubmissions.id]: RecentFormSubmissions as WidgetDefinition<unknown, unknown>,
  [FamilyListTable.id]: FamilyListTable as WidgetDefinition<unknown, unknown>,
  [FamilyDetailCard.id]: FamilyDetailCard as WidgetDefinition<unknown, unknown>,
  [StudentCardList.id]: StudentCardList as WidgetDefinition<unknown, unknown>,
  [StudentRosterTable.id]: StudentRosterTable as WidgetDefinition<unknown, unknown>,
  [EnrollmentByGradeChart.id]: EnrollmentByGradeChart as WidgetDefinition<unknown, unknown>,
  [EnrollmentTargetsTable.id]: EnrollmentTargetsTable as WidgetDefinition<unknown, unknown>,
  [RecentEnrollments.id]: RecentEnrollments as WidgetDefinition<unknown, unknown>,
  [AdmissionsFunnelStages.id]: AdmissionsFunnelStages as WidgetDefinition<unknown, unknown>,
  [PaymentDashboardPlaceholder.id]: PaymentDashboardPlaceholder as WidgetDefinition<unknown, unknown>,
  [MarketingDashboardPlaceholder.id]: MarketingDashboardPlaceholder as WidgetDefinition<unknown, unknown>,
  [EnrollmentHubTable.id]: EnrollmentHubTable as WidgetDefinition<unknown, unknown>,
  [FamilyHubTable.id]: FamilyHubTable as WidgetDefinition<unknown, unknown>,
  [StudentRosterRich.id]: StudentRosterRich as WidgetDefinition<unknown, unknown>,
  [DocumentTracker.id]: DocumentTracker as WidgetDefinition<unknown, unknown>,
  [RostersHub.id]: RostersHub as WidgetDefinition<unknown, unknown>,
  [FinanceDashboard.id]: FinanceDashboard as WidgetDefinition<unknown, unknown>,
  [DonorDashboard.id]: DonorDashboard as WidgetDefinition<unknown, unknown>,
  [FinancialAidQueue.id]: FinancialAidQueue as WidgetDefinition<unknown, unknown>,
  [AttendanceDashboard.id]: AttendanceDashboard as WidgetDefinition<unknown, unknown>,
  [PortalFormsCompletionGrid.id]: PortalFormsCompletionGrid as WidgetDefinition<unknown, unknown>,
  [PortalFormsTracker.id]: PortalFormsTracker as WidgetDefinition<unknown, unknown>,
  [PortalFormsInbox.id]: PortalFormsInbox as WidgetDefinition<unknown, unknown>,
  [PaymentsOverview.id]: PaymentsOverview as WidgetDefinition<unknown, unknown>,
  [StudentDocumentsBrowser.id]: StudentDocumentsBrowser as WidgetDefinition<unknown, unknown>,
  [ClassroomHotLunch.id]: ClassroomHotLunch as WidgetDefinition<unknown, unknown>,
  [ClassroomParentContacts.id]: ClassroomParentContacts as WidgetDefinition<unknown, unknown>,
  [ClassroomPickupRestrictions.id]: ClassroomPickupRestrictions as WidgetDefinition<unknown, unknown>,
  [ClassroomAllergies.id]: ClassroomAllergies as WidgetDefinition<unknown, unknown>,
  [StudentImmunizations.id]: StudentImmunizations as WidgetDefinition<unknown, unknown>,
};

export function getWidget(widgetId: string): WidgetDefinition<unknown, unknown> | null {
  return widgetRegistry[widgetId] ?? null;
}

export function listWidgets(): WidgetDefinition<unknown, unknown>[] {
  return Object.values(widgetRegistry);
}
