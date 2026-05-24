'use client';

// DG-style accordion table. Click a row → expands inline panel below
// showing parents + per-student details. State is local React state;
// only one row open at a time so the page doesn't grow without bound.
//
// Sort headers remain real anchor tags so server-side sort URL state still
// works inside this client component. (Anchors trigger navigation; React
// state only governs row expansion.)

import { useState } from 'react';
import { AlertTriangle, ChevronRight, ChevronDown, ArrowUpDown, ChevronUp } from 'lucide-react';
import type { ColumnKey, SortKey } from './config';
import type { FamilyRow, ParentRecord, StudentRecord } from './fetcher';
import type { WidgetSearchParams } from '@/lib/widgets/types';

const EMDASH = '—';

const SORT_BY_COL: Partial<Record<ColumnKey, SortKey>> = {
  family: 'family',
  students: 'students',
  enrollment: 'enrollment',
  payment_plan: 'payment_plan',
  total_tuition: 'total_tuition',
  active: 'active',
};

interface Props {
  rows: FamilyRow[];
  columns: ColumnKey[];
  locationId: string;
  current: WidgetSearchParams;
  // CRM base URL used to build "Open Full Contact Record" deep-links to
  // GHL. Resolved server-side from CRM_APP_BASE env and passed down here
  // because client components can't read non-public env vars.
  crmAppBase: string;
}

export function AccordionTable({ rows, columns, locationId, current, crmAppBase }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
        No families match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="w-6 px-2 py-2" />{/* chevron */}
            {columns.map((col) => {
              const align = col === 'total_tuition' ? 'text-right' : col === 'active' ? 'text-center' : '';
              const sortKey = SORT_BY_COL[col];
              return (
                <th key={col} className={`px-3 py-2 font-medium ${align}`}>
                  {sortKey ? (
                    <SortHeader label={COLUMN_LABEL[col] ?? col} sortKey={sortKey} current={current} align={align} />
                  ) : (
                    COLUMN_LABEL[col] ?? col
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((f) => {
            const isOpen = expanded === f.family_id;
            return (
              <FamilyAccordionRow
                key={f.family_id}
                family={f}
                columns={columns}
                expanded={isOpen}
                onToggle={() => setExpanded(isOpen ? null : f.family_id)}
                locationId={locationId}
                crmAppBase={crmAppBase}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const COLUMN_LABEL: Record<string, string> = {
  family: 'Family',
  phone: 'Phone',
  email: 'Email',
  students: 'Students',
  enrollment: 'Enrollment',
  programs: 'Programs',
  payment_plan: 'Payment Plan',
  total_tuition: 'Total Tuition',
  active: 'Active',
};

function FamilyAccordionRow({
  family: f,
  columns,
  expanded,
  onToggle,
  locationId,
  crmAppBase,
}: {
  family: FamilyRow;
  columns: ColumnKey[];
  expanded: boolean;
  onToggle: () => void;
  locationId: string;
  crmAppBase: string;
}) {
  const titleLabel = pickTitle(f);
  const subtitle = pickSubtitle(f);

  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer ${expanded ? 'bg-emerald-50/50' : 'hover:bg-gray-50'}`}
      >
        <td className="px-2 py-2 align-top text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        {columns.map((col) => (
          <td
            key={col}
            className={`px-3 py-2 align-top ${col === 'total_tuition' ? 'text-right' : col === 'active' ? 'text-center' : ''}`}
          >
            {renderCell(f, col, titleLabel, subtitle)}
          </td>
        ))}
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={columns.length + 1} className="bg-gray-50 p-0 border-y border-emerald-200">
            <FamilyDetailPanel family={f} locationId={locationId} crmAppBase={crmAppBase} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function pickTitle(f: FamilyRow): string {
  const dn = (f.family_display_name ?? '').trim();
  const dnLooksJunk = !dn || dn === '(prospective)' || dn === 'Prospective Family' || dn === 'Unnamed';
  if (!dnLooksJunk) return dn;
  const studentLabel = f.student_names ? f.student_names.split(',')[0].trim() : '';
  const primaryLabel = f.primary_parent_name === '(unnamed)' ? '' : f.primary_parent_name;
  if (studentLabel) return `${studentLabel} (prospective)`;
  if (primaryLabel) return `${primaryLabel} Family`;
  return '(unnamed prospective)';
}

function pickSubtitle(f: FamilyRow): string {
  const primaryLabel = f.primary_parent_name === '(unnamed)' ? '' : f.primary_parent_name;
  if (primaryLabel) return primaryLabel;
  const studentLabel = f.student_names ? f.student_names.split(',')[0].trim() : '';
  return studentLabel ? `student: ${studentLabel}` : '(no contact name)';
}

function renderCell(f: FamilyRow, col: ColumnKey, title: string, subtitle: string): React.ReactNode {
  switch (col) {
    case 'family':
      return (
        <div className="min-w-0">
          <div className="font-medium text-gray-900" style={{ color: 'var(--brand, #047857)' }}>
            {title}
            {f.has_allergy ? <AlertTriangle className="ml-1 inline h-3 w-3 text-rose-600" /> : null}
          </div>
          <div className="text-[11px] text-gray-500">{subtitle}</div>
        </div>
      );
    case 'phone': return <span className="text-gray-700">{f.primary_parent_phone ?? EMDASH}</span>;
    case 'email': return <span className="text-gray-700 truncate">{f.primary_parent_email ?? EMDASH}</span>;
    case 'students':
      return (
        <div>
          <span className="font-medium text-gray-900">{f.student_count}</span>
          {f.student_names ? <div className="text-[11px] text-gray-500 truncate max-w-xs">{f.student_names}</div> : null}
        </div>
      );
    case 'enrollment':
      return f.enrollment_summary ? (
        <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800">
          {f.enrollment_summary.replace(/_/g, ' ')}
        </span>
      ) : <span className="text-gray-400">{EMDASH}</span>;
    case 'programs': return <span className="text-gray-700 truncate">{f.programs || EMDASH}</span>;
    case 'payment_plan': return <span className="text-gray-700">{f.payment_plan || EMDASH}</span>;
    case 'total_tuition':
      return <span className="tabular-nums text-gray-900">{f.total_tuition > 0 ? `$${f.total_tuition.toLocaleString()}` : EMDASH}</span>;
    case 'active':
      return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${f.family_status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-zinc-200 text-zinc-600'}`}>
          {f.family_status}
        </span>
      );
  }
}

// ----- Expanded family detail panel -----------------------------------------

function FamilyDetailPanel({
  family,
  locationId,
  crmAppBase,
}: {
  family: FamilyRow;
  locationId: string;
  crmAppBase: string;
}) {
  const primary = family.parents.find((p) => p.is_primary) ?? family.parents[0];
  const secondary = family.parents.filter((p) => p !== primary);

  return (
    <div className="px-6 py-5 space-y-5">
      {/* Family + parents header */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-4 text-sm">
        <div className="space-y-1">
          <SectionLabel>Family</SectionLabel>
          <div className="text-gray-900 font-medium">{family.family_display_name || '(unnamed)'}</div>
          <div className="text-gray-700 text-xs">
            {family.student_count} {family.student_count === 1 ? 'student' : 'students'}
            {' · '}
            {family.parent_count} {family.parent_count === 1 ? 'parent' : 'parents'}
          </div>
          {family.enrollment_summary ? (
            <div className="text-xs text-gray-600">
              Status: <span className="font-medium">{family.enrollment_summary.replace(/_/g, ' ')}</span>
            </div>
          ) : null}
          {family.payment_plan ? (
            <div className="text-xs text-gray-600">Plan: {family.payment_plan}</div>
          ) : null}
          {family.total_tuition > 0 ? (
            <div className="text-xs text-gray-600">Tuition: ${family.total_tuition.toLocaleString()}</div>
          ) : null}
          {primary?.ghl_contact_id ? (
            <a
              href={`${crmAppBase}/v2/location/${locationId}/contacts/detail/${primary.ghl_contact_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Open Full Contact Record →
            </a>
          ) : null}
        </div>

        {primary ? <ParentBlock label="Parent 1" parent={primary} locationId={locationId} crmAppBase={crmAppBase} /> : <div />}
        {secondary[0] ? (
          <ParentBlock label="Parent 2" parent={secondary[0]} locationId={locationId} crmAppBase={crmAppBase} />
        ) : (
          <div className="text-xs text-gray-400 italic self-end">No second parent on record.</div>
        )}
      </div>

      {/* Per-student detail cards */}
      {family.students.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {family.students.map((s) => (
            <StudentDetailCard key={s.id} student={s} />
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-400 italic">No students on record.</div>
      )}
    </div>
  );
}

function ParentBlock({
  label,
  parent,
  locationId,
  crmAppBase,
}: {
  label: string;
  parent: ParentRecord;
  locationId: string;
  crmAppBase: string;
}) {
  const fullName = [parent.first_name, parent.last_name].filter(Boolean).join(' ').trim() || '(no name)';
  const contactUrl = parent.ghl_contact_id
    ? `${crmAppBase}/v2/location/${locationId}/contacts/detail/${parent.ghl_contact_id}`
    : null;
  return (
    <div className="space-y-0.5">
      <SectionLabel>{label}</SectionLabel>
      <div className="text-gray-900 font-medium">{fullName}</div>
      {parent.email ? <div className="text-gray-700 text-xs truncate">{parent.email}</div> : null}
      {parent.phone ? <div className="text-gray-700 text-xs">{parent.phone}</div> : null}
      {contactUrl ? (
        <a
          href={contactUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:text-emerald-900 hover:underline"
        >
          Open contact record →
        </a>
      ) : null}
    </div>
  );
}

function StudentDetailCard({ student }: { student: StudentRecord }) {
  const fullName = [student.first_name, student.preferred_name ? `(${student.preferred_name})` : '', student.last_name]
    .filter(Boolean)
    .join(' ')
    .trim() || 'Student';
  const enrollmentLabel = student.enrollment_status ? student.enrollment_status.replace(/_/g, ' ') : '';
  const md = student.metadata ?? {};

  // Bucket the known metadata fields into named sections. Anything we
  // don't recognize falls into a generic "Other" bucket so operators can
  // still see it without us having to enumerate every school's fields.
  const sections = bucketMetadata(md, student);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-3 border-b border-gray-100 pb-2">
        <div>
          <SectionLabel>Student</SectionLabel>
          <div className="text-base font-semibold text-gray-900">{fullName}</div>
          <div className="text-xs text-gray-600 mt-0.5">
            {student.date_of_birth ? `Born ${fmtDate(student.date_of_birth)}` : ''}
            {student.gender ? ` · ${student.gender}` : ''}
            {student.classroom_name ? ` · ${student.classroom_name}` : ''}
          </div>
        </div>
        {enrollmentLabel ? (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${enrollmentBadgeClass(student.enrollment_status)}`}>
            {enrollmentLabel}
          </span>
        ) : null}
      </div>

      {sections.map((sec) =>
        sec.rows.length > 0 ? (
          <DetailSection key={sec.title} title={sec.title} rows={sec.rows} />
        ) : null
      )}
    </div>
  );
}

interface SectionDef {
  title: string;
  rows: Array<[string, string]>;
}

function bucketMetadata(md: Record<string, unknown>, st: StudentRecord): SectionDef[] {
  const get = (k: string): string => {
    const v = md[k];
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v;
    return String(v);
  };

  const money = (k: string): string => {
    const raw = get(k);
    if (!raw) return '';
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) return '';
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  };

  const enrollment: Array<[string, string]> = [
    ['Status', st.enrollment_status?.replace(/_/g, ' ') ?? ''],
    ['Started', fmtDate(get('initial_start_date'))],
    ['This year', fmtDate(get('current_year_enrollment_start_date') || st.enrolled_at || '')],
    ['Grade', st.grade_level ?? get('grade_level')],
    ['Program', get('program')],
    ['Homeroom', get('homeroom')],
    ['Schedule', st.schedule ?? get('daily_schedule')],
    ['Lead teacher', get('lead_teacher')],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  const financial: Array<[string, string]> = [
    ['Tuition fee', money('tuition_fee')],
    ['Extended day', money('extended_day_fee')],
    ['Lunch', money('lunch_fee')],
    ['Admin', money('admin_fee')],
    ['Enrollment', money('enrollment_fee')],
    ['Late', money('late_fee')],
    ['Total', money('total_amount')],
    ['Plan', get('payment_plan')],
    ['Annual disc.', money('annual_discount')],
    ['Sibling disc.', money('sibling_discount')],
    ['Employee disc.', money('employee_discount')],
    ['Financial aid', money('financial_aid')],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  const health: Array<[string, string]> = [
    ['Allergy', get('allergy')],
    ['IEP', get('iep')],
    ['504 plan', get('504_plan')],
    ['H/V fall', get('hearing_and_vision_fall')],
    ['H/V spring', get('hearing_and_vision_spring')],
  ].filter(([, v]) => !!v && v.toLowerCase() !== 'no' && v.toLowerCase() !== 'none') as Array<[string, string]>;

  const services: Array<[string, string]> = [];
  if (get('service_1')) {
    services.push([`Service 1 (${get('service_1')})`, money('service_1_bill_amount') || '—']);
  }
  if (get('service_2')) {
    services.push([`Service 2 (${get('service_2')})`, money('service_2_bill_amount') || '—']);
  }

  const summer: Array<[string, string]> = [
    ['Program', get('summer_program')],
    ['Schedule', get('summer_schedule')],
    ['Classroom', get('summer_classroom')],
    ['June', get('summer_month_june')],
    ['July', get('summer_month_july')],
    ['Lunch', get('summer_lunch')],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  const az: Array<[string, string]> = [
    ['ESA recipient', get('esa_recipient')],
    ['ESA amount', money('esa_amount')],
    ['STO recipient', get('sto_recipient')],
    ['STO type', get('sto_type')],
    ['STO amount', money('sto_amount')],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  // Form completion — keyed under a sub-object during sync
  const fc = (md.form_completion ?? {}) as Record<string, string>;
  const forms: Array<[string, string]> = Object.entries(fc)
    .filter(([, v]) => v && String(v).trim() !== '')
    .map(([k, v]) => [k.replace(/_/g, ' '), String(v)]);

  // Anything we didn't bucket goes into Other — minus the keys we already
  // surfaced via other paths, and minus the internal "ghl_*"/system keys.
  const known = new Set<string>([
    'preferred_name', 'birth_date', 'gender', 'grade_level', 'program', 'homeroom',
    'enrollment_status', 'initial_start_date', 'current_year_enrollment_start_date',
    'iep', '504_plan', 'daily_schedule', 'lead_teacher', 'allergy',
    'tuition_fee', 'extended_day_fee', 'lunch_fee', 'admin_fee', 'enrollment_fee',
    'late_fee', 'total_amount', 'payment_plan', 'organic_lunch',
    'annual_discount', 'employee_discount', 'sibling_discount', 'financial_aid',
    'service_1', 'service_1_bill_amount', 'service_2', 'service_2_bill_amount',
    'hearing_and_vision_fall', 'hearing_and_vision_spring',
    'summer_program', 'summer_schedule', 'summer_classroom',
    'summer_form_received_date', 'summer_month_june', 'summer_month_july', 'summer_lunch',
    'sst_status', 'sst_start_date', 'sst_fee',
    'esa_recipient', 'esa_amount', 'sto_recipient', 'sto_type', 'sto_amount',
    'employee_kid', 'referral_credit', 'referred_by',
    'form_completion', 'ghl_slot', 'ghl_contact_id', 'household_id', 'first_name', 'last_name',
  ]);
  const other: Array<[string, string]> = Object.entries(md)
    .filter(([k, v]) => !known.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => [k.replace(/_/g, ' '), String(v)]);

  return [
    { title: 'Enrollment', rows: enrollment },
    { title: 'Financial', rows: financial },
    { title: 'Health', rows: health },
    { title: 'Services', rows: services },
    { title: 'Summer', rows: summer },
    { title: 'AZ programs', rows: az },
    { title: 'Forms', rows: forms },
    { title: 'Other', rows: other },
  ];
}

function DetailSection({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50/50 p-2.5">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{title}</div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-gray-500">{k}</dt>
            <dd className="text-gray-800 truncate">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-wide text-gray-500 font-semibold">{children}</div>
  );
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function SortHeader({
  label,
  sortKey,
  current,
  align,
}: {
  label: string;
  sortKey: SortKey;
  current: WidgetSearchParams;
  align?: string;
}) {
  const active = (current.sort ?? 'family') === sortKey;
  const dir = active && current.dir === 'desc' ? 'desc' : (active ? 'asc' : null);
  const nextDir = active && dir === 'asc' ? 'desc' : 'asc';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && k !== 'sort' && k !== 'dir' && k !== 'page') params.set(k, v);
  }
  params.set('sort', sortKey);
  params.set('dir', nextDir);
  const Icon = active ? (dir === 'desc' ? ChevronDown : ChevronUp) : ArrowUpDown;
  const cls = align?.includes('right') ? 'justify-end' : align?.includes('center') ? 'justify-center' : '';
  return (
    <a href={`?${params.toString()}`} className={`inline-flex items-center gap-0.5 hover:text-gray-700 ${cls}`}>
      {label} <Icon className="h-3 w-3" />
    </a>
  );
}

function enrollmentBadgeClass(status: string): string {
  switch (status) {
    case 'enrolled':   return 'bg-emerald-100 text-emerald-800';
    case 'accepted':   return 'bg-blue-100 text-blue-800';
    case 'application_submitted':
    case 'tour_scheduled':
    case 'inquiry':    return 'bg-amber-100 text-amber-800';
    case 'waitlisted': return 'bg-yellow-100 text-yellow-800';
    case 'declined':
    case 'withdrawn':  return 'bg-zinc-200 text-zinc-700';
    default:           return 'bg-gray-100 text-gray-700';
  }
}
