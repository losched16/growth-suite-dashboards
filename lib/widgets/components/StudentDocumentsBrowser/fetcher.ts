// Documents Browser fetcher. Pulls the per-school document index +
// the student dropdown options for the upload form.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { StudentDocumentsBrowserConfig } from './config';

export interface DocumentRow {
  id: string;
  student_id: string;
  student_label: string;            // "Last, First" for sorting
  student_display: string;          // "First Last" for display
  classroom_name: string | null;
  title: string;
  category: string | null;
  description: string | null;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  uploaded_at: string;
  visible_to_teacher: boolean;
  visible_to_parent: boolean;
  expires_at: string | null;
}

export interface StudentOption {
  id: string;
  display: string;
  classroom_name: string | null;
}

export interface StudentDocumentsBrowserData {
  rows: DocumentRow[];
  total: number;             // total docs before filter
  filtered: number;          // after filters
  page: number;
  per_page: number;
  page_count: number;
  // Dropdown options
  students: StudentOption[];
  categories: string[];      // distinct categories present in this school
  total_size_bytes: number;  // sum across visible/filtered rows
}

const CATEGORIES = ['health', 'enrollment', 'iep', 'transcript', 'other'];

export async function fetcher(
  school: SchoolContext,
  config: StudentDocumentsBrowserConfig,
  searchParams?: WidgetSearchParams,
): Promise<StudentDocumentsBrowserData> {
  const sp = searchParams ?? {};

  // ── Documents (pre-filter) ─────────────────────────────────────────
  const { rows: rawDocs } = await query<{
    id: string;
    student_id: string;
    student_first: string;
    student_last: string;
    student_preferred: string | null;
    classroom_name: string | null;
    title: string;
    category: string | null;
    description: string | null;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string | null;
    uploaded_at: string;
    visible_to_teacher: boolean;
    visible_to_parent: boolean;
    expires_at: string | null;
  }>(
    `SELECT
       d.id,
       d.student_id,
       s.first_name      AS student_first,
       s.last_name       AS student_last,
       s.preferred_name  AS student_preferred,
       c.name            AS classroom_name,
       d.title, d.category, d.description,
       d.file_name, d.mime_type, d.size_bytes,
       d.uploaded_by, d.uploaded_at,
       d.visible_to_teacher, d.visible_to_parent, d.expires_at
     FROM student_documents d
     JOIN students s   ON s.id = d.student_id
     LEFT JOIN LATERAL (
       SELECT classroom_id FROM enrollments
        WHERE student_id = s.id
        ORDER BY created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     WHERE d.school_id = $1
     ORDER BY d.uploaded_at DESC`,
    [school.schoolId],
  );

  const allRows: DocumentRow[] = rawDocs.map((r) => {
    const displayFirst = (r.student_preferred?.trim() || r.student_first || '').trim();
    return {
      id: r.id,
      student_id: r.student_id,
      student_label: `${(r.student_last || '').toLowerCase()},${displayFirst.toLowerCase()}`,
      student_display: `${displayFirst} ${r.student_last ?? ''}`.trim(),
      classroom_name: r.classroom_name,
      title: r.title,
      category: r.category,
      description: r.description,
      file_name: r.file_name,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      uploaded_by: r.uploaded_by,
      uploaded_at: typeof r.uploaded_at === 'string' ? r.uploaded_at : new Date(r.uploaded_at).toISOString(),
      visible_to_teacher: r.visible_to_teacher,
      visible_to_parent: r.visible_to_parent,
      expires_at: r.expires_at ? (typeof r.expires_at === 'string' ? r.expires_at : new Date(r.expires_at).toISOString().slice(0, 10)) : null,
    };
  });

  // ── Filters ────────────────────────────────────────────────────────
  // Standard filters:
  //   q              free-text across title/file/desc/student/classroom
  //   student        narrow to a single student_id
  //   category       narrow by category (health/iep/transcript/...)
  //   parent_visible only show docs the parent can see
  // Teacher-hub filters (so the same widget can serve both audiences):
  //   classroom      filter by the student's enrollment classroom name
  //                  (used by the "Documents" tab on classroom hubs)
  //   audience       'teacher' hides docs with visible_to_teacher=false
  //                  so admin-only files (HR notes, sensitive drafts)
  //                  never leak to a teacher view
  const q = (sp.q ?? '').trim().toLowerCase();
  const studentFilter = (sp.student ?? '').trim();
  const categoryFilter = (sp.category ?? '').trim().toLowerCase();
  const parentVisibleOnly = sp.parent_visible === '1';
  const classroomFilter = (sp.classroom ?? '').trim();
  const teacherAudience = (sp.audience ?? '').trim().toLowerCase() === 'teacher';

  const filtered = allRows.filter((d) => {
    if (studentFilter && d.student_id !== studentFilter) return false;
    if (categoryFilter && (d.category ?? '') !== categoryFilter) return false;
    if (parentVisibleOnly && !d.visible_to_parent) return false;
    if (teacherAudience && !d.visible_to_teacher) return false;
    if (classroomFilter && (d.classroom_name ?? '') !== classroomFilter) return false;
    if (q) {
      const hay = [d.title, d.file_name, d.description ?? '', d.student_display, d.classroom_name ?? ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // ── Pagination ─────────────────────────────────────────────────────
  const perPage = Math.max(25, Math.min(500, Number(sp.per_page) || config.page_size || 100));
  const page = Math.max(1, Number(sp.page) || 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  // ── Student dropdown ──────────────────────────────────────────────
  const { rows: students } = await query<{
    id: string; first: string; last: string; preferred: string | null;
    classroom_name: string | null;
  }>(
    `SELECT
       s.id, s.first_name AS first, s.last_name AS last, s.preferred_name AS preferred,
       c.name AS classroom_name
     FROM students s
     LEFT JOIN LATERAL (
       SELECT classroom_id FROM enrollments
        WHERE student_id = s.id
        ORDER BY created_at DESC LIMIT 1
     ) e ON true
     LEFT JOIN classrooms c ON c.id = e.classroom_id
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY s.last_name, s.first_name
     LIMIT 5000`,
    [school.schoolId],
  );
  const studentOptions: StudentOption[] = students.map((r) => ({
    id: r.id,
    display: `${(r.preferred?.trim() || r.first)} ${r.last}`.trim(),
    classroom_name: r.classroom_name,
  }));

  return {
    rows: pageRows,
    total: allRows.length,
    filtered: filtered.length,
    page: safePage,
    per_page: perPage,
    page_count: pageCount,
    students: studentOptions,
    categories: CATEGORIES,
    total_size_bytes: filtered.reduce((s, r) => s + r.size_bytes, 0),
  };
}
