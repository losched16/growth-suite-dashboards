// Default layouts for the 7 dashboards. Real widgets will replace
// HelloWorldWidget references in Step 23 once the widgets are built.
//
// When a school is provisioned, every entry in this map gets a row in
// school_dashboards with the layout below. The school can then override
// per-dashboard.

import { randomUUID } from 'node:crypto';
import { FormCompletionGrid } from '@/lib/widgets/components/FormCompletionGrid';
import { RecentFormSubmissions } from '@/lib/widgets/components/RecentFormSubmissions';
import { FamilyListTable } from '@/lib/widgets/components/FamilyListTable';
import { FamilyDetailCard } from '@/lib/widgets/components/FamilyDetailCard';
import { StudentCardList } from '@/lib/widgets/components/StudentCardList';
import { StudentRosterTable } from '@/lib/widgets/components/StudentRosterTable';
import { EnrollmentByGradeChart } from '@/lib/widgets/components/EnrollmentByGradeChart';
import { EnrollmentTargetsTable } from '@/lib/widgets/components/EnrollmentTargetsTable';
import { RecentEnrollments } from '@/lib/widgets/components/RecentEnrollments';
import { EnrollmentHubTable } from '@/lib/widgets/components/EnrollmentHubTable';
import { enrollmentHubDefaults } from '@/lib/widgets/components/EnrollmentHubTable/config';
import { FamilyHubTable } from '@/lib/widgets/components/FamilyHubTable';
import { familyHubDefaults } from '@/lib/widgets/components/FamilyHubTable/config';
import { StudentRosterRich } from '@/lib/widgets/components/StudentRosterRich';
import { studentRosterDefaults } from '@/lib/widgets/components/StudentRosterRich/config';
import { DocumentTracker } from '@/lib/widgets/components/DocumentTracker';
import { documentTrackerDefaults } from '@/lib/widgets/components/DocumentTracker/config';
import { RostersHub } from '@/lib/widgets/components/RostersHub';
import { rostersHubDefaults } from '@/lib/widgets/components/RostersHub/config';
import { FinanceDashboard } from '@/lib/widgets/components/FinanceDashboard';
import { financeDashboardDefaults } from '@/lib/widgets/components/FinanceDashboard/config';
import { AdmissionsFunnelStages } from '@/lib/widgets/components/AdmissionsFunnelStages';
import { PaymentDashboardPlaceholder } from '@/lib/widgets/components/PaymentDashboardPlaceholder';
import { MarketingDashboardPlaceholder } from '@/lib/widgets/components/MarketingDashboardPlaceholder';
import { DonorDashboard } from '@/lib/widgets/components/DonorDashboard';
import { donorDashboardDefaults } from '@/lib/widgets/components/DonorDashboard/config';
import { FinancialAidQueue } from '@/lib/widgets/components/FinancialAidQueue';
import { financialAidQueueDefaults } from '@/lib/widgets/components/FinancialAidQueue/config';
import { AttendanceDashboard } from '@/lib/widgets/components/AttendanceDashboard';
import { attendanceDashboardDefaults } from '@/lib/widgets/components/AttendanceDashboard/config';
import type { DashboardDefinition } from './types';
import type { WidgetInstance } from '@/lib/widgets/types';

function instance(widgetId: string, config: unknown, h = 6): WidgetInstance {
  return {
    instance_id: randomUUID(),
    widget_id: widgetId,
    config,
    position: { x: 0, y: 0, w: 12, h },
  };
}

export const dashboardRegistry: Record<string, DashboardDefinition> = {
  'document-tracker': {
    slug: 'document-tracker',
    display_name: 'Document Tracker',
    description: 'Family-row tracker with per-student chips per form. Auto-refreshes.',
    icon: 'FileText',
    default_layout: [
      instance(DocumentTracker.id, documentTrackerDefaults, 12),
    ],
  },
  'family-hub': {
    slug: 'family-hub',
    display_name: 'Family Hub',
    description: 'Stat cards, search, filters, sortable family table with click-through to family detail.',
    icon: 'Users',
    default_layout: [
      instance(FamilyHubTable.id, familyHubDefaults, 12),
    ],
    detail_layout: [
      // family_id is injected by the [familyId] route at render time.
      instance(FamilyDetailCard.id, {}, 4),
      instance(StudentCardList.id, {}, 6),
    ],
  },
  'student-roster': {
    slug: 'student-roster',
    display_name: 'Student Roster',
    description: 'List / Grid / Allergies views with filters, search, and sortable columns.',
    icon: 'GraduationCap',
    default_layout: [
      instance(StudentRosterRich.id, studentRosterDefaults, 12),
    ],
  },
  'rosters-hub': {
    slug: 'rosters-hub',
    display_name: 'Rosters Hub',
    description: 'Tabbed multi-roster view: School Year, Summer, SST, Enrichment, Sports, H&V, ESA, STO, Fin Aid, Employees, Siblings, Schedule, Referrals.',
    icon: 'GraduationCap',
    default_layout: [
      instance(RostersHub.id, rostersHubDefaults, 12),
    ],
  },
  'enrollment-hub': {
    slug: 'enrollment-hub',
    display_name: 'Enrollment Hub',
    description: 'Top-line stats, by-program/by-homeroom breakdowns, and a searchable + filterable student roster.',
    icon: 'TrendingUp',
    default_layout: [
      instance(EnrollmentHubTable.id, enrollmentHubDefaults, 12),
    ],
  },
  'admissions-tracker': {
    slug: 'admissions-tracker',
    display_name: 'Admissions Tracker',
    description: 'Monitor your prospective family pipeline.',
    icon: 'Megaphone',
    default_layout: [
      instance(AdmissionsFunnelStages.id, { academic_year: '2026-27' }, 6),
    ],
  },
  'tuition-dashboard': {
    slug: 'tuition-dashboard',
    display_name: 'Tuition & Payments',
    description: 'Tuition plans, payment status, and family billing.',
    icon: 'CreditCard',
    default_layout: [
      instance(PaymentDashboardPlaceholder.id, {}, 4),
    ],
  },
  finance: {
    slug: 'finance',
    display_name: 'Finance',
    description: 'Contracted revenue, discounts, aid totals, recipient lists. Actual cash flows come with Smart Payments.',
    icon: 'CreditCard',
    default_layout: [
      instance(FinanceDashboard.id, financeDashboardDefaults, 12),
    ],
  },
  'marketing-dashboard': {
    slug: 'marketing-dashboard',
    display_name: 'Marketing',
    description: 'Lead sources, social engagement, and conversion.',
    icon: 'BarChart3',
    default_layout: [
      instance(MarketingDashboardPlaceholder.id, {}, 4),
    ],
  },
  donors: {
    slug: 'donors',
    display_name: 'Donors',
    description:
      'Donor segments, annual giving by school year, top donors, and a searchable ' +
      'directory with inline donor detail. Source: DonorPerfect.',
    icon: 'HeartHandshake',
    default_layout: [
      instance(DonorDashboard.id, donorDashboardDefaults, 24),
    ],
  },
  'financial-aid': {
    slug: 'financial-aid',
    display_name: 'Financial Aid',
    description:
      'Review parent-submitted financial aid applications, set recommended awards, ' +
      'and finalize decisions.',
    icon: 'HandCoins',
    default_layout: [
      instance(FinancialAidQueue.id, financialAidQueueDefaults, 16),
    ],
  },
  attendance: {
    slug: 'attendance',
    display_name: 'Attendance',
    description:
      'Real-time drop-off / pick-up view: live counts, classroom filters, ' +
      'manual override, and CSV exports for state reporting.',
    icon: 'UserCheck',
    default_layout: [
      instance(AttendanceDashboard.id, attendanceDashboardDefaults, 18),
    ],
  },
};

export function getDashboard(slug: string): DashboardDefinition | null {
  return dashboardRegistry[slug] ?? null;
}

export function listDashboards(): DashboardDefinition[] {
  return Object.values(dashboardRegistry);
}
