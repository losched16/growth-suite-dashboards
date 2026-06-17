// Student Immunizations — the NC immunization tracker. Three views, all
// server-rendered and print-friendly:
//   - grid    : students × vaccines (dose counts + status) — mirrors the
//               NC age worksheet Mara fills out by hand today.
//   - reports : the auto-filled NC Annual reports (Child Care / K / 7th)
//               — Section I rollup + Section III per-vaccine matrix.
//   - student : one child's full dose history (mirrors Transparent Classroom).
//
// Status math lives in lib/immunizations/engine.ts (pure + reusable).
// Records come from student_immunization_doses / _profile / _flags.

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext, ConfigSchema, WidgetSearchParams } from '@/lib/widgets/types';
import { Syringe, Printer, AlertTriangle, ShieldCheck } from 'lucide-react';
import { PrintButton } from '../_shared/PrintButton';
import { ImmunizationEditor } from './Editor';
import {
  VACCINES, type VaccineCode, type ReportContext, type DoseStatus,
} from '@/lib/immunizations/schedule';
import {
  computeStudent, buildReport, buildChildCareSummary, vaccinesForContext,
  type StudentImmunizationInput, type StudentStatus, type DoseRow, type VaccineFlag, type ImmunizationProfile,
  type ReportCategory, type NcReport,
} from '@/lib/immunizations/engine';

export interface ImmunizationsConfig {
  default_room_filter?: string;
}

interface StudentMeta {
  student_id: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  program: string | null;
  homeroom: string | null;
  grade: string | null;
}

interface Data {
  asOf: string;
  rooms: string[];
  students: Array<{ meta: StudentMeta; status: StudentStatus; doses: DoseRow[]; flags: VaccineFlag[]; profile: ImmunizationProfile | null }>;
  reports: Partial<Record<ReportContext, NcReport>>;
  childCareSummary: ReturnType<typeof buildChildCareSummary>;
}

const CANON_ORDER: VaccineCode[] = ['dtap', 'ipv', 'hib', 'hepb', 'mmr', 'var', 'pcv', 'tdap', 'mcv'];

async function fetcher(school: SchoolContext): Promise<Data> {
  const asOf = new Date();

  // DOB may live on the column or (for GHL-synced rows) in metadata.
  // Program/homeroom come from explicit keys OR the GHL pipeline name
  // ("Primary Pipeline" → "Primary"). Grade falls back through the
  // admissions-survey keys.
  const { rows: students } = await query<StudentMeta>(
    `SELECT s.id AS student_id, s.first_name, s.last_name, s.preferred_name,
            COALESCE(s.date_of_birth, (s.metadata->>'date_of_birth')::date) AS date_of_birth,
            COALESCE(s.metadata->>'program',
                     NULLIF(regexp_replace(s.metadata->>'ghl_pipeline_name', ' Pipeline$', ''), '')) AS program,
            COALESCE(s.metadata->>'homeroom', s.metadata->>'classroom_name',
                     NULLIF(regexp_replace(s.metadata->>'ghl_pipeline_name', ' Pipeline$', ''), '')) AS homeroom,
            COALESCE(s.metadata->>'grade', s.metadata->>'grade_level',
                     s.metadata->>'current_grade_level') AS grade
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
      ORDER BY s.last_name, s.first_name`,
    [school.schoolId],
  );

  const ids = students.map((s) => s.student_id);
  const empty = { asOf: asOf.toISOString(), rooms: [], students: [],
    reports: {} as Record<ReportContext, NcReport>, childCareSummary: [] };
  if (ids.length === 0) return empty;

  const [{ rows: doseRows }, { rows: flagRows }, { rows: profileRows }] = await Promise.all([
    query<DoseRow & { student_id: string }>(
      `SELECT student_id, vaccine_code, dose_number,
              to_char(date_administered,'YYYY-MM-DD') AS date_administered, status_override
         FROM student_immunization_doses WHERE school_id = $1`, [school.schoolId]),
    query<VaccineFlag & { student_id: string }>(
      `SELECT student_id, vaccine_code, exemption, immunity_documented, not_required
         FROM student_vaccine_flags WHERE school_id = $1`, [school.schoolId]),
    query<ImmunizationProfile & { student_id: string }>(
      `SELECT student_id, certificate_on_file, all_vaccine_exemption, in_process, in_process_note, report_context_override
         FROM student_immunization_profile WHERE school_id = $1`, [school.schoolId]),
  ]);

  const dosesByStudent = new Map<string, DoseRow[]>();
  for (const d of doseRows) {
    if (!dosesByStudent.has(d.student_id)) dosesByStudent.set(d.student_id, []);
    dosesByStudent.get(d.student_id)!.push(d);
  }
  const flagsByStudent = new Map<string, VaccineFlag[]>();
  for (const f of flagRows) {
    if (!flagsByStudent.has(f.student_id)) flagsByStudent.set(f.student_id, []);
    flagsByStudent.get(f.student_id)!.push(f);
  }
  const profileByStudent = new Map<string, ImmunizationProfile>();
  for (const p of profileRows) profileByStudent.set(p.student_id, p);

  const computed = students.map((meta) => {
    const input: StudentImmunizationInput = {
      student_id: meta.student_id,
      date_of_birth: meta.date_of_birth,
      program: meta.program,
      homeroom: meta.homeroom,
      grade: meta.grade,
      doses: dosesByStudent.get(meta.student_id) ?? [],
      flags: flagsByStudent.get(meta.student_id) ?? [],
      profile: profileByStudent.get(meta.student_id) ?? null,
    };
    return { meta, status: computeStudent(input, asOf), doses: input.doses, flags: input.flags, profile: input.profile };
  });

  const allStatuses = computed.map((c) => c.status);
  // Only the three contexts NC requires an annual report for.
  const reports: Partial<Record<ReportContext, NcReport>> = {
    child_care: buildReport(allStatuses, 'child_care'),
    kindergarten: buildReport(allStatuses, 'kindergarten'),
    grade_7: buildReport(allStatuses, 'grade_7'),
  };

  const rooms = Array.from(new Set(students.map((s) => s.homeroom || s.program || '').filter(Boolean))).sort();

  return {
    asOf: asOf.toISOString(),
    rooms,
    students: computed,
    reports,
    childCareSummary: buildChildCareSummary(allStatuses),
  };
}

// ── presentation helpers ──────────────────────────────────────────────
const CATEGORY_LABEL: Record<ReportCategory, string> = {
  up_to_date: 'Up to Date',
  medical_exemption: 'Medical Exempt',
  religious_exemption: 'Religious Exempt',
  in_process: 'In Process',
  incomplete_record: 'Incomplete',
  no_record: 'No Record',
};
function categoryPill(c: ReportCategory): string {
  switch (c) {
    case 'up_to_date': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'medical_exemption':
    case 'religious_exemption': return 'bg-violet-100 text-violet-800 border-violet-300';
    case 'in_process': return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'incomplete_record': return 'bg-orange-100 text-orange-800 border-orange-300';
    case 'no_record': return 'bg-rose-100 text-rose-800 border-rose-300';
  }
}
function doseGlyph(s: DoseStatus): { ch: string; cls: string; title: string } {
  switch (s) {
    case 'done': return { ch: '✓', cls: 'text-emerald-700', title: 'Received' };
    case 'near_due': return { ch: '!', cls: 'text-amber-600 font-bold', title: 'Near due' };
    case 'overdue': return { ch: '✗', cls: 'text-rose-600 font-bold', title: 'Overdue' };
    case 'exempt': return { ch: 'e', cls: 'text-violet-600', title: 'Exempt' };
    case 'not_applicable': return { ch: '–', cls: 'text-slate-300', title: 'Not applicable' };
    case 'upcoming': return { ch: '·', cls: 'text-slate-300', title: 'Not yet due' };
  }
}

function displayName(m: StudentMeta): string {
  return `${m.preferred_name || m.first_name} ${m.last_name}`;
}
function fmtDob(s: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Build an href that preserves existing search params + overrides some.
function hrefWith(current: WidgetSearchParams, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) if (v != null && v !== '') params.set(k, v);
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === '') params.delete(k); else params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '?';
}

const CTX_LABEL: Record<ReportContext, string> = {
  child_care: 'Child Care', kindergarten: 'Kindergarten', school_other: 'Grades 1–6', grade_7: '7th Grade', grade_12: '12th Grade',
};

function Component({ data, searchParams }: { school: SchoolContext; config: ImmunizationsConfig; data: Data; searchParams?: WidgetSearchParams }) {
  const sp = searchParams ?? {};
  const view = sp.imm_view === 'reports' ? 'reports' : sp.imm_student ? 'student' : 'grid';
  const room = sp.imm_room || '';

  if (data.students.length === 0) {
    return (
      <div className="rounded-lg border-2 border-violet-200 bg-violet-50/40 p-6 text-center">
        <Syringe className="h-6 w-6 text-violet-500 mx-auto mb-2" />
        <p className="text-sm font-semibold text-violet-900">No students on the roster yet.</p>
        <p className="text-xs text-violet-700 mt-1">Once the roster imports, every child&rsquo;s immunization status, due/overdue flags, and the NC annual reports populate here automatically.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* header + view toggle */}
      <div className="flex items-center justify-between flex-wrap gap-2 print:hidden">
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <Syringe className="h-4 w-4 text-violet-600" /> Immunizations
        </h2>
        <div className="flex items-center gap-1 text-xs">
          <ViewTab label="Classroom grid" active={view === 'grid'} href={hrefWith(sp, { imm_view: undefined, imm_student: undefined })} />
          <ViewTab label="NC reports" active={view === 'reports'} href={hrefWith(sp, { imm_view: 'reports', imm_student: undefined })} />
          <PrintButton label="Print" title="Print this view" />
        </div>
      </div>

      {view === 'student' && sp.imm_student
        ? <StudentDetail data={data} studentId={sp.imm_student} backHref={hrefWith(sp, { imm_student: undefined })} />
        : view === 'reports'
        ? <ReportsView data={data} sp={sp} />
        : <GridView data={data} sp={sp} room={room} />}
    </div>
  );
}

function ViewTab({ label, active, href }: { label: string; active: boolean; href: string }) {
  return (
    <a href={href} className={`px-2.5 py-1 rounded-md border font-medium ${active ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{label}</a>
  );
}

// ── GRID: students × vaccines (the NC worksheet layout) ───────────────
function GridView({ data, sp, room }: { data: Data; sp: WidgetSearchParams; room: string }) {
  const rows = room ? data.students.filter((s) => (s.meta.homeroom || s.meta.program) === room) : data.students;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap print:hidden">
        <span className="text-[11px] text-slate-500">Classroom:</span>
        <a href={hrefWith(sp, { imm_room: undefined })} className={`text-[11px] px-2 py-0.5 rounded border ${!room ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>All</a>
        {data.rooms.map((r) => (
          <a key={r} href={hrefWith(sp, { imm_room: r })} className={`text-[11px] px-2 py-0.5 rounded border ${room === r ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>{r}</a>
        ))}
      </div>

      <Legend />

      <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto print:border-0">
        <table className="w-full text-sm print:text-[10px]">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left font-semibold sticky left-0 bg-slate-50">Student</th>
              <th className="px-2 py-2 text-left font-semibold">DOB</th>
              {CANON_ORDER.map((v) => (
                <th key={v} className="px-1.5 py-2 text-center font-semibold" title={VACCINES[v].label}>{VACCINES[v].short}</th>
              ))}
              <th className="px-2 py-2 text-center font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ meta, status }) => {
              const byV = new Map(status.vaccines.map((vs) => [vs.vaccine, vs]));
              return (
                <tr key={meta.student_id} className="hover:bg-violet-50/40 break-inside-avoid">
                  <td className="px-2 py-1.5 sticky left-0 bg-white">
                    <a href={hrefWith(sp, { imm_student: meta.student_id, imm_view: undefined })} className="font-medium text-violet-800 hover:underline">{displayName(meta)}</a>
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-slate-500 whitespace-nowrap">{fmtDob(meta.date_of_birth)}</td>
                  {CANON_ORDER.map((v) => {
                    const vs = byV.get(v);
                    if (!vs) return <td key={v} className="px-1.5 py-1.5 text-center text-slate-300">–</td>;
                    const cls = vs.category === 'up_to_date' ? 'text-emerald-700'
                      : vs.exemption !== 'none' ? 'text-violet-600'
                      : vs.required === 0 ? 'text-slate-300'
                      : 'text-rose-600 font-semibold';
                    const txt = vs.exemption !== 'none' ? 'e' : vs.required === 0 ? '–' : `${vs.recorded}`;
                    const need = vs.required > 0 && vs.exemption === 'none' && vs.recorded < vs.required ? `/${vs.required}` : '';
                    return (
                      <td key={v} className={`px-1.5 py-1.5 text-center tabular-nums ${cls}`} title={`${VACCINES[v].label}: ${vs.recorded} recorded${vs.required ? ` of ${vs.required} required` : ''}`}>
                        {txt}<span className="text-[9px] text-slate-400">{need}</span>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center">
                    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${categoryPill(status.overall)}`}>{CATEGORY_LABEL[status.overall]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">{rows.length} student{rows.length === 1 ? '' : 's'}{room ? ` in ${room}` : ''}. Numbers are doses received; <span className="text-rose-600 font-semibold">red</span> = below the NC requirement for the child&rsquo;s age. Click a name for full dose history.</p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 print:text-[9px]">
      <span><span className="text-emerald-700 font-semibold">✓</span> Received</span>
      <span><span className="text-amber-600 font-bold">!</span> Near due</span>
      <span><span className="text-rose-600 font-bold">✗</span> Overdue</span>
      <span><span className="text-violet-600">e</span> Exempt</span>
      <span><span className="text-slate-400">–</span> Not applicable</span>
    </div>
  );
}

// ── REPORTS: auto-filled NC annual reports ────────────────────────────
function ReportsView({ data, sp }: { data: Data; sp: WidgetSearchParams }) {
  const ctx = (['child_care', 'kindergarten', 'grade_7'] as ReportContext[]).includes(sp.imm_ctx as ReportContext)
    ? (sp.imm_ctx as ReportContext) : 'kindergarten';
  const rpt = data.reports[ctx];
  if (!rpt) return <p className="text-sm text-slate-500">No report data.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 text-xs print:hidden">
        {(['child_care', 'kindergarten', 'grade_7'] as ReportContext[]).map((c) => (
          <a key={c} href={hrefWith(sp, { imm_ctx: c })} className={`px-2.5 py-1 rounded-md border font-medium ${ctx === c ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{CTX_LABEL[c]} ({data.reports[c]?.enrollment ?? 0})</a>
        ))}
      </div>

      <div className="rounded-lg border-2 border-violet-200 bg-white overflow-hidden">
        <div className="bg-violet-100/60 px-4 py-2 border-b border-violet-200">
          <h3 className="text-sm font-semibold text-violet-900">NC Annual {CTX_LABEL[ctx]} Immunization Report — auto-filled</h3>
          <p className="text-[11px] text-violet-700">Enter these numbers into the NC online portal. Generated {new Date(data.asOf).toLocaleDateString()}.</p>
        </div>
        <div className="p-4 space-y-4">
          {ctx === 'child_care' ? <ChildCareSummary data={data} /> : null}

          {/* Section I */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1">Section I — Compliance Summary</div>
            <table className="w-full text-sm border border-slate-200">
              <tbody className="divide-y divide-slate-200">
                <SecRow label="Total enrollment" value={rpt.enrollment} bold />
                <SecRow label="3a. All Required Doses (Up to Date)" value={rpt.all_required_doses} />
                <SecRow label="3b. Medical Exemption (all vaccines)" value={rpt.medical_exemption} />
                <SecRow label="3c. Religious Exemption (all vaccines)" value={rpt.religious_exemption} />
                <SecRow label="3d. Not Up to Date (in process + incomplete + no record)" value={rpt.not_up_to_date} />
                <SecRow label="Q7. In Process" value={rpt.in_process} sub />
                <SecRow label="Q8. No Record" value={rpt.no_record} sub />
              </tbody>
            </table>
          </div>

          {/* Section III */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1">Section III — Vaccine-Specific Status (each row totals enrollment)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border border-slate-200">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Vaccine</th>
                    <th className="px-2 py-1.5 text-center">Up to Date</th>
                    <th className="px-2 py-1.5 text-center">Medical</th>
                    <th className="px-2 py-1.5 text-center">Religious</th>
                    <th className="px-2 py-1.5 text-center">In Process</th>
                    <th className="px-2 py-1.5 text-center">Incomplete</th>
                    <th className="px-2 py-1.5 text-center">No Record</th>
                    <th className="px-2 py-1.5 text-center font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {rpt.by_vaccine.map((c) => (
                    <tr key={c.vaccine}>
                      <td className="px-2 py-1.5 font-medium text-slate-800">{VACCINES[c.vaccine].short}</td>
                      <td className="px-2 py-1.5 text-center text-emerald-700">{c.up_to_date}</td>
                      <td className="px-2 py-1.5 text-center">{c.medical_exemption}</td>
                      <td className="px-2 py-1.5 text-center">{c.religious_exemption}</td>
                      <td className="px-2 py-1.5 text-center">{c.in_process}</td>
                      <td className="px-2 py-1.5 text-center text-orange-700">{c.incomplete_record}</td>
                      <td className="px-2 py-1.5 text-center text-rose-700">{c.no_record}</td>
                      <td className="px-2 py-1.5 text-center font-semibold tabular-nums">{c.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SecRow({ label, value, bold, sub }: { label: string; value: number; bold?: boolean; sub?: boolean }) {
  return (
    <tr className={bold ? 'bg-slate-50' : ''}>
      <td className={`px-3 py-1.5 ${sub ? 'pl-6 text-slate-500 text-xs' : 'text-slate-700'} ${bold ? 'font-semibold' : ''}`}>{label}</td>
      <td className={`px-3 py-1.5 text-right tabular-nums w-20 ${bold ? 'font-bold' : 'font-medium'}`}>{value}</td>
    </tr>
  );
}

function ChildCareSummary({ data }: { data: Data }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold mb-1">Child Care Summary Table (by age group)</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border border-slate-200">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-600">
            <tr>
              <th className="px-2 py-1.5 text-left">Age group</th>
              <th className="px-2 py-1.5 text-center">Attending</th>
              <th className="px-2 py-1.5 text-center">Up to Date</th>
              <th className="px-2 py-1.5 text-center">In process</th>
              <th className="px-2 py-1.5 text-center">Not UTD, no exemption</th>
              <th className="px-2 py-1.5 text-center">Medical</th>
              <th className="px-2 py-1.5 text-center">Religious</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {data.childCareSummary.map((r) => (
              <tr key={r.label}>
                <td className="px-2 py-1.5 text-slate-700">{r.label}</td>
                <td className="px-2 py-1.5 text-center tabular-nums">{r.attending}</td>
                <td className="px-2 py-1.5 text-center text-emerald-700 tabular-nums">{r.up_to_date}</td>
                <td className="px-2 py-1.5 text-center tabular-nums">{r.in_process}</td>
                <td className="px-2 py-1.5 text-center text-rose-700 tabular-nums">{r.not_utd_no_exemption}</td>
                <td className="px-2 py-1.5 text-center tabular-nums">{r.medical_exemption}</td>
                <td className="px-2 py-1.5 text-center tabular-nums">{r.religious_exemption}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── STUDENT DETAIL: full dose history (TC mirror) ─────────────────────
function StudentDetail({ data, studentId, backHref }: { data: Data; studentId: string; backHref: string }) {
  const entry = data.students.find((s) => s.meta.student_id === studentId);
  if (!entry) return <p className="text-sm text-slate-500">Student not found. <a href={backHref} className="text-violet-700 underline">Back</a></p>;
  const { meta, status, doses, flags, profile } = entry;
  const dosesByV = new Map<string, DoseRow[]>();
  for (const d of doses) {
    if (!dosesByV.has(d.vaccine_code)) dosesByV.set(d.vaccine_code, []);
    dosesByV.get(d.vaccine_code)!.push(d);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <a href={backHref} className="text-[11px] text-violet-700 hover:underline print:hidden">← Back to grid</a>
          <h3 className="text-base font-semibold text-slate-900">{displayName(meta)}</h3>
          <p className="text-[11px] text-slate-500">DOB {fmtDob(meta.date_of_birth)} · {meta.homeroom || meta.program || '—'} · {CTX_LABEL[status.context]} schedule · <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-semibold ${categoryPill(status.overall)}`}>{CATEGORY_LABEL[status.overall]}</span></p>
        </div>
        <PrintButton label="Print" title="Print this child's immunization record" />
      </div>

      <div className="space-y-2">
        {status.vaccines.map((vs) => {
          const def = VACCINES[vs.vaccine];
          const recs = (dosesByV.get(vs.vaccine) ?? []).sort((a, b) => a.dose_number - b.dose_number);
          return (
            <div key={vs.vaccine} className="rounded-lg border border-slate-200 overflow-hidden">
              <div className="bg-slate-800 text-white px-3 py-1.5 flex items-baseline justify-between">
                <span className="text-sm font-medium">{def.label} <span className="text-[10px] text-slate-300">({def.aliases})</span></span>
                <span className="text-[10px] text-slate-300">{vs.exemption !== 'none' ? `${vs.exemption} exemption` : `${vs.recorded}${vs.required ? ` / ${vs.required}` : ''} doses`}</span>
              </div>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {vs.doses.map((ds, i) => {
                    const n = i + 1;
                    const rec = recs.find((r) => r.dose_number === n);
                    const g = doseGlyph(ds);
                    return (
                      <tr key={n} className={ds === 'overdue' ? 'bg-rose-50' : ds === 'near_due' ? 'bg-amber-50' : ''}>
                        <td className="px-3 py-1 w-10 text-slate-500">{n}</td>
                        <td className={`px-2 py-1 w-8 text-center ${g.cls}`} title={g.title}>{g.ch}</td>
                        <td className="px-2 py-1 text-slate-700">{g.title}</td>
                        <td className="px-3 py-1 text-right text-slate-500 tabular-nums">{rec?.date_administered ? fmtDob(rec.date_administered) : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-200 pt-3 print:hidden">
        <h4 className="text-sm font-semibold text-slate-800 mb-1">Edit records</h4>
        <p className="text-[11px] text-slate-500 mb-2">Enter dose dates, mark exemptions or documented immunity, or flag a missing certificate. Saving recomputes the grid and the NC reports.</p>
        <ImmunizationEditor
          studentId={studentId}
          vaccines={status.vaccines.map((v) => v.vaccine)}
          initialDoses={doses}
          initialFlags={flags}
          initialProfile={profile}
        />
      </div>
    </div>
  );
}

const schema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'default_room_filter', label: 'Default classroom filter', placeholder: '(all classrooms)' },
  ],
};

export const StudentImmunizations: WidgetDefinition<ImmunizationsConfig, Data> = {
  id: 'student_immunizations',
  display_name: 'Immunization Tracker',
  description: 'NC immunization tracking — classroom grid (doses + due/overdue), full per-child dose history, and the auto-filled NC Annual reports (Child Care / Kindergarten / 7th Grade).',
  category: 'student',
  default_config: { default_room_filter: '' },
  config_schema: schema,
  default_size: { w: 12, h: 14 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
