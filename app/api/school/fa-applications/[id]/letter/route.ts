// GET /api/school/fa-applications/[id]/letter
//
// Returns the decision letter as a print-ready HTML page. The admin
// (or parent) opens it in a tab and uses the browser's "Print → Save
// as PDF" to get a downloadable PDF — no server-side PDF library
// dependency.
//
// Template comes from school_financial_aid_settings.decision_letter_
// template (markdown-ish with {{variable}} substitution). Falls back
// to a generic Growth Suite template when blank.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { query } from '@/lib/db';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { getFinancialAidSettings } from '@/lib/financial-aid/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string }>;

const DEFAULT_TEMPLATE = `Dear {{family_name}},

Thank you for applying for financial aid at {{school_name}} for the {{academic_year}} academic year.

We are pleased to share the following financial aid decision for your enrolled students:

{{student_list}}

**Total annual award: {{total_award}}**

{{decision_note}}

We appreciate the trust you have placed in {{school_name}} and look forward to a wonderful year together.

Warmly,
{{signature_name}}
{{signature_title}}`;

function fmtMoney(n: number | null): string {
  if (n === null) return '—';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Render markdown-ish lines to safe HTML: ** → bold, line breaks → <br>,
// blank lines → paragraphs. Defensive — we don't trust the template
// to be safe HTML.
function renderMd(s: string): string {
  const safe = escapeHtml(s);
  return safe
    .split(/\n{2,}/)
    .map((p) => p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>'))
    .map((p) => `<p>${p}</p>`)
    .join('\n');
}

export async function GET(_req: Request, { params }: { params: Params }) {
  const { id } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { rows: app } = await query<{
    id: string; family_id: string; academic_year: string;
    recommended_award: string | null; decision_note: string | null;
    status: string; school_name: string; family_display: string | null;
  }>(
    `SELECT a.id, a.family_id, a.academic_year, a.recommended_award::text,
            a.decision_note, a.status,
            sc.name AS school_name,
            f.display_name AS family_display
       FROM fa_applications a
       JOIN families f ON f.id = a.family_id
       JOIN schools sc ON sc.id = a.school_id
      WHERE a.id = $1 AND a.school_id = $2`,
    [id, session.school_id],
  );
  if (app.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const a = app[0];

  const { rows: students } = await query<{
    student_id: string; first_name: string; last_name: string; preferred_name: string | null;
    current_tuition: string | null; recommended_award: string | null; award_note: string | null;
  }>(
    `SELECT s.id AS student_id, s.first_name, s.last_name, s.preferred_name,
            c.current_tuition::text, c.recommended_award::text, c.award_note
       FROM fa_application_students c
       JOIN students s ON s.id = c.student_id
      WHERE c.application_id = $1
      ORDER BY s.first_name`,
    [id],
  );

  const settings = await getFinancialAidSettings(session.school_id);
  const tpl = settings.decision_letter_template?.trim() || DEFAULT_TEMPLATE;

  const totalAward = students.reduce((sum, st) => sum + Number(st.recommended_award ?? 0), 0);

  // Variable substitutions — keep keys in sync with the form's
  // placeholder hint in SettingsForm.tsx.
  const studentList = students
    .map((st) => {
      const name = st.preferred_name?.trim() || st.first_name;
      const award = fmtMoney(st.recommended_award === null ? null : Number(st.recommended_award));
      const tuition = fmtMoney(st.current_tuition === null ? null : Number(st.current_tuition));
      const note = st.award_note ? ` — ${st.award_note}` : '';
      return `- ${name} ${st.last_name}: ${award} of ${tuition} tuition${note}`;
    })
    .join('\n');

  const variables: Record<string, string> = {
    family_name: a.family_display ?? 'Family',
    school_name: a.school_name,
    academic_year: a.academic_year,
    student_list: studentList,
    total_award: fmtMoney(totalAward),
    decision_note: a.decision_note ?? '',
    signature_name: settings.signature_name ?? a.school_name + ' Financial Aid Committee',
    signature_title: settings.signature_title ?? '',
  };

  const filled = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k as keyof typeof variables] ?? '');
  const body = renderMd(filled);

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Financial Aid Decision — ${escapeHtml(a.family_display ?? 'Family')}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 56px auto; padding: 0 48px; color: #111; line-height: 1.55; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin: 0 0 32px; }
  p { font-size: 14px; margin: 12px 0; }
  strong { color: #0f172a; }
  .stamp { margin-top: 48px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 11px; color: #888; }
  @media print {
    body { margin: 0; padding: 0.5in; }
    .noprint { display: none; }
  }
  .noprint { background: #f1f5f9; border-radius: 6px; padding: 10px 14px; margin-bottom: 24px; font-size: 12px; color: #475569; }
  button { background: #047857; color: #fff; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; }
</style></head>
<body>
  <div class="noprint">
    <strong>Decision letter preview.</strong> Use your browser&rsquo;s Print menu (or <button onclick="window.print()">Print / Save PDF</button>) to save a PDF copy.
  </div>
  <h1>Financial Aid Decision</h1>
  <p class="sub">${escapeHtml(a.school_name)} · ${escapeHtml(a.academic_year)} school year</p>
  ${body}
  <p class="stamp">Application ${escapeHtml(a.id)} · ${escapeHtml(a.status)}</p>
</body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
