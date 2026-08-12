// "Student moved to Enrolled" office notifications (Aug 11 call).
//
// Runs after each school's sync: diffs current students against the
// enrollment_status_ledger (migration 098) and emails the school's
// configured recipients (schools.settings.enrollment_notification_emails)
// one message per student whose status transitioned INTO 'enrolled'.
//
// Lead-teacher logic (the "conditional logic" from the call): the
// student's own lead_teacher field from the roster import wins; else the
// classroom table's teacher for their homeroom; else "not yet assigned"
// with the grade shown — a brand-new enrollee often has no classroom yet.
//
// Safety rails:
//   - First run for a school seeds the ledger and sends NOTHING.
//   - Recipients unconfigured → ledger still maintained, no email (so
//     turning the list on later never causes a back-blast).
//   - notified_enrolled_at: the same student won't re-notify within 14
//     days even if their status ping-pongs during data cleanup.
//   - Best-effort: never fails the sync.

import { query } from '@/lib/db';
import { sendBrandedEmail } from '@/lib/email';
import { loadSchoolSettings } from '@/lib/school-settings';

interface StudentRow {
  id: string;
  name: string;
  status_raw: string;
  grade: string;
  program: string;
  homeroom: string;
  lead_teacher: string;
  start_date: string;
  parent_name: string;
  parent_email: string;
  parent_phone: string;
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function fireEnrollmentNotifications(
  schoolId: string,
): Promise<{ seeded: boolean; transitions: number; notified: number }> {
  const settings = await loadSchoolSettings(schoolId);
  const recipients = settings.enrollment_notification_emails
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  const { rows: students } = await query<StudentRow>(
    `SELECT s.id,
            CONCAT_WS(' ', COALESCE(NULLIF(s.preferred_name, ''), s.first_name), s.last_name) AS name,
            COALESCE(s.metadata->>'enrollment_status', '') AS status_raw,
            COALESCE(s.metadata->>'grade_level', '') AS grade,
            COALESCE(s.metadata->>'program', '') AS program,
            COALESCE(NULLIF(s.metadata->>'homeroom',''), s.metadata->>'classroom_name', '') AS homeroom,
            COALESCE(s.metadata->>'lead_teacher', '') AS lead_teacher,
            COALESCE(s.metadata->>'initial_start_date', s.metadata->>'current_year_start_date', '') AS start_date,
            COALESCE((SELECT p.first_name || ' ' || p.last_name FROM parents p
                       WHERE p.family_id = s.family_id AND p.is_primary AND p.status = 'active' LIMIT 1), '') AS parent_name,
            COALESCE((SELECT p.email FROM parents p
                       WHERE p.family_id = s.family_id AND p.is_primary AND p.status = 'active' LIMIT 1), '') AS parent_email,
            COALESCE((SELECT p.phone FROM parents p
                       WHERE p.family_id = s.family_id AND p.is_primary AND p.status = 'active' LIMIT 1), '') AS parent_phone
       FROM students s
      WHERE s.school_id = $1 AND s.status = 'active'
        AND (s.metadata->>'is_demo') IS DISTINCT FROM 'true'`,
    [schoolId],
  );

  const { rows: ledger } = await query<{ student_id: string; last_status: string; notified_enrolled_at: string | null }>(
    `SELECT student_id, last_status, notified_enrolled_at FROM enrollment_status_ledger WHERE school_id = $1`,
    [schoolId],
  );
  const prior = new Map(ledger.map((l) => [l.student_id, l]));
  const firstRun = ledger.length === 0;

  // Classroom → teacher fallback for enrollees whose student record has
  // no lead_teacher yet.
  const { rows: classrooms } = await query<{ name: string; lead_teacher_name: string | null }>(
    `SELECT name, lead_teacher_name FROM classrooms WHERE school_id = $1`,
    [schoolId],
  );
  const teacherByClassroom = new Map(classrooms.map((c) => [norm(c.name), c.lead_teacher_name ?? '']));

  const toNotify: StudentRow[] = [];
  for (const s of students) {
    const cur = norm(s.status_raw);
    const was = prior.get(s.id);
    const wasEnrolled = was ? norm(was.last_status) === 'enrolled' : false;
    const recentlyNotified = was?.notified_enrolled_at
      ? Date.now() - new Date(was.notified_enrolled_at).getTime() < 14 * 24 * 3600 * 1000
      : false;
    if (!firstRun && cur === 'enrolled' && !wasEnrolled && !recentlyNotified) {
      toNotify.push(s);
    }
    await query(
      `INSERT INTO enrollment_status_ledger (school_id, student_id, student_name, last_status, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (school_id, student_id) DO UPDATE SET
         student_name = EXCLUDED.student_name,
         last_status = EXCLUDED.last_status,
         updated_at = now()`,
      [schoolId, s.id, s.name, s.status_raw],
    );
  }
  // Prune ledger rows for students that no longer exist (kept out of the
  // students DELETE cascade on purpose — see migration 098).
  await query(
    `DELETE FROM enrollment_status_ledger
      WHERE school_id = $1 AND student_id NOT IN (SELECT id FROM students WHERE school_id = $1)`,
    [schoolId],
  );

  let notified = 0;
  if (recipients.length > 0) {
    for (const s of toNotify) {
      const teacher = s.lead_teacher.trim()
        || (teacherByClassroom.get(norm(s.homeroom)) ?? '').trim();
      const teacherLine = teacher
        ? teacher
        : `not yet assigned${s.grade ? ` (grade ${s.grade})` : ''}`;
      const subject = `New enrollment: ${s.name}${s.grade ? ` (${s.grade})` : ''}`;
      const lines = [
        `${s.name} has been moved to Enrolled.`,
        '',
        `Grade: ${s.grade || '—'}`,
        `Program: ${s.program || '—'}`,
        `Classroom: ${s.homeroom || 'not yet assigned'}`,
        `Lead teacher: ${teacherLine}`,
        ...(s.start_date ? [`Start date: ${s.start_date}`] : []),
        '',
        `Parent: ${s.parent_name || '—'}`,
        ...(s.parent_email ? [`Email: ${s.parent_email}`] : []),
        ...(s.parent_phone ? [`Phone: ${s.parent_phone}`] : []),
        '',
        'Automated notice from Growth Suite — sent when a student\'s enrollment status changes to Enrolled.',
      ];
      const html = `<p>${esc(s.name)} has been moved to <strong>Enrolled</strong>.</p>
<table cellpadding="4" style="border-collapse:collapse">
<tr><td><strong>Grade</strong></td><td>${esc(s.grade || '—')}</td></tr>
<tr><td><strong>Program</strong></td><td>${esc(s.program || '—')}</td></tr>
<tr><td><strong>Classroom</strong></td><td>${esc(s.homeroom || 'not yet assigned')}</td></tr>
<tr><td><strong>Lead teacher</strong></td><td>${esc(teacherLine)}</td></tr>
${s.start_date ? `<tr><td><strong>Start date</strong></td><td>${esc(s.start_date)}</td></tr>` : ''}
<tr><td><strong>Parent</strong></td><td>${esc(s.parent_name || '—')}</td></tr>
${s.parent_email ? `<tr><td><strong>Email</strong></td><td>${esc(s.parent_email)}</td></tr>` : ''}
${s.parent_phone ? `<tr><td><strong>Phone</strong></td><td>${esc(s.parent_phone)}</td></tr>` : ''}
</table>
<p style="color:#6b7280;font-size:12px">Automated notice from Growth Suite — sent when a student's enrollment status changes to Enrolled.</p>`;
      try {
        await sendBrandedEmail({
          to: recipients,
          schoolId,
          subject,
          html,
          text: lines.join('\n'),
        });
        await query(
          `UPDATE enrollment_status_ledger SET notified_enrolled_at = now()
            WHERE school_id = $1 AND student_id = $2`,
          [schoolId, s.id],
        );
        notified++;
      } catch (e) {
        console.error('[enrollment-notify] send failed for', s.name, ':',
          e instanceof Error ? e.message : String(e));
      }
    }
  }

  return { seeded: firstRun, transitions: toNotify.length, notified };
}
