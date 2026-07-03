// Prebuilt dashboard templates — the self-serve gallery any school can
// create dashboards from (no operator involved). Each template returns the
// school_dashboards rows to insert; configs use the widgets' own defaults
// plus the school's proven-good starting points, and everything is
// re-editable afterwards in the dashboard editor.
//
// The classroom-hubs template is a GENERATOR: one dashboard per classroom
// that has enrolled students (teacher class lists — enrolled only, pinned).

import crypto from 'node:crypto';
import { query } from '@/lib/db';

export interface TemplateDashboard {
  dashboard_slug: string;
  display_name: string;
  description: string;
  layout: Array<{
    config: Record<string, unknown>;
    position: { h: number; w: number; x: number; y: number };
    widget_id: string;
    instance_id: string;
  }>;
}

export interface DashboardTemplate {
  key: string;
  title: string;
  description: string;
  // Slugs this template creates (for "already added" detection). The
  // classroom generator reports the prefix instead.
  slugs: string[] | { prefix: string };
  build: (schoolId: string, academicYear: string) => Promise<TemplateDashboard[]>;
}

const pos = { h: 12, w: 12, x: 0, y: 0 };
const iid = () => crypto.randomBytes(16).toString('hex');

function single(slug: string, name: string, description: string, widgetId: string, config: Record<string, unknown>, h = 12): TemplateDashboard {
  return {
    dashboard_slug: slug,
    display_name: name,
    description,
    layout: [{ config, position: { ...pos, h }, widget_id: widgetId, instance_id: iid() }],
  };
}

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    key: 'family-hub',
    title: 'Family Hub',
    description: 'Every family at a glance — students, contact info, enrollment, payment plan. Click a family for full detail.',
    slugs: ['family-hub'],
    build: async (_schoolId, year) => [single('family-hub', 'Family Hub',
      'Families, students, and contact info',
      'family_hub_table', {
        page_size: 50,
        academic_year: year,
        shown_columns: ['family', 'phone', 'students', 'enrollment', 'payment_plan', 'active'],
        shown_filters: ['family_status', 'enrollment_status', 'program'],
        show_stat_cards: true,
        drilldown_dashboard_slug: 'family-hub',
        default_enrollment_status: 'enrolled',
      })],
  },
  {
    key: 'student-roster',
    title: 'Student Roster',
    description: 'The full student list — program, homeroom, schedule, allergies, IEP/504. Enrolled by default, with pending/withdrawn views.',
    slugs: ['student-roster'],
    build: async () => [single('student-roster', 'Student Roster',
      'All students with program, homeroom, and health flags',
      'student_roster_rich', {
        page_size: 100,
        enable_views: ['list', 'grid', 'allergies'],
        shown_columns: ['student', 'gender_age', 'program', 'homeroom', 'lead_teacher', 'schedule', 'status', 'allergy', 'iep_504', 'family'],
        shown_filters: ['program', 'homeroom', 'schedule', 'lead_teacher', 'allergies_only', 'iep_504_only'],
        drilldown_dashboard_slug: 'family-hub',
      })],
  },
  {
    key: 'enrollment-hub',
    title: 'Enrollment Hub',
    description: 'Enrollment tracking by status, program, and homeroom, with stat cards and breakdowns.',
    slugs: ['enrollment-hub'],
    build: async (_schoolId, year) => [single('enrollment-hub', 'Enrollment Hub',
      'Enrollment status tracking',
      'enrollment_hub_table', {
        academic_year: year,
        shown_columns: ['student', 'status', 'program', 'homeroom', 'lead_teacher', 'schedule', 'started', 'age', 'family'],
        shown_filters: ['status', 'program', 'homeroom', 'schedule', 'lead_teacher'],
        show_breakdowns: true,
        show_stat_cards: true,
        drilldown_dashboard_slug: 'family-hub',
      })],
  },
  {
    key: 'finance',
    title: 'Finance Dashboard',
    description: 'Tuition and fees rolled up by program — charges, credits, discounts, and net.',
    slugs: ['finance'],
    build: async () => [single('finance', 'Finance',
      'Tuition + fee roll-up by program',
      'finance_dashboard', {})],
  },
  {
    key: 'rosters-hub',
    title: 'Rosters Hub',
    description: 'Purpose-built lists: school-year roster, siblings, schedules, and more — printable and exportable.',
    slugs: ['rosters-hub'],
    build: async () => [single('rosters-hub', 'Rosters Hub',
      'Purpose-built roster views',
      'rosters_hub', {
        shown_tabs: ['school_year', 'siblings', 'schedule'],
        default_tab: 'school_year',
        drilldown_dashboard_slug: 'family-hub',
      })],
  },
  {
    key: 'portal-forms',
    title: 'Portal Forms Inbox',
    description: 'Incoming parent form submissions plus a per-family completion tracker.',
    slugs: ['portal-forms'],
    build: async (_schoolId, year) => [{
      dashboard_slug: 'portal-forms',
      display_name: 'Portal Forms',
      description: 'Form submissions inbox + completion tracker',
      layout: [
        { config: { limit: 30, academic_year: year, status_filter: 'all' }, position: { ...pos, h: 10 }, widget_id: 'portal_forms_inbox', instance_id: iid() },
        { config: { drilldown: 'family-forms', auto_refresh_ms: 60000 }, position: { h: 12, w: 12, x: 0, y: 10 }, widget_id: 'portal_forms_tracker', instance_id: iid() },
      ],
    }],
  },
  {
    key: 'document-tracker',
    title: 'Document Tracker',
    description: 'Which required documents each family has turned in, and what is still missing.',
    slugs: ['document-tracker'],
    build: async () => [single('document-tracker', 'Document Tracker',
      'Required-document completion by family',
      'document_tracker', { auto_refresh_ms: 60000, drilldown_dashboard_slug: 'family-hub' })],
  },
  {
    key: 'classroom-hubs',
    title: 'Classroom Hubs (one per classroom)',
    description: 'A dashboard per classroom for teachers — enrolled students only, with family contact info, allergies, pickups, and health detail. Generated from your classrooms.',
    slugs: { prefix: 'classroom-' },
    build: async (schoolId) => {
      const { rows } = await query<{ name: string; n: number }>(
        `SELECT c.name, count(e.id)::int n FROM classrooms c
          JOIN enrollments e ON e.classroom_id = c.id AND e.status = 'enrolled'
         WHERE c.school_id = $1 GROUP BY c.name HAVING count(e.id) > 0 ORDER BY c.name`,
        [schoolId],
      );
      const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return rows.map((r) => ({
        dashboard_slug: 'classroom-' + slugify(r.name).replace(/^classroom-/, ''),
        display_name: `${r.name} Hub`,
        description: `Class roster for ${r.name} — enrolled students only`,
        layout: [{
          config: {
            page_size: 100,
            enable_views: ['list', 'grid', 'allergies'],
            enrolled_only: true,
            shown_columns: ['student', 'gender_age', 'schedule', 'allergy', 'special_instructions', 'iep_504', 'lunch', 'pickup_restrictions', 'documents', 'family'],
            shown_filters: ['program', 'schedule', 'allergies_only', 'iep_504_only', 'lunch_only'],
            documents_audience: 'teacher',
            default_homeroom_filter: r.name,
            drilldown_dashboard_slug: 'family-hub',
          },
          position: { h: 32, w: 12, x: 0, y: 0 },
          widget_id: 'student_roster_rich',
          instance_id: iid(),
        }],
      }));
    },
  },
];
