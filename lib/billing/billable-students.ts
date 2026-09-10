// Which students can be billed.
//
// `students.status` is NOT the answer: the GHL snapshot sync rebuilds every
// student as 'active' and puts the real state on the latest `enrollments`
// row. Filtering audiences on students.status alone is how NLMA's first
// bulk send (2026-09-09) invoiced nine families whose children had all
// withdrawn, plus the test fixtures.
//
// A student is billable when their latest enrollment is 'enrolled'.
// Accepted / waitlisted / on-hold / withdrawn / alumni / declined are all
// excluded — a fee is for a child who is actually attending. A student with
// NO enrollment row is billable only at a school that has no enrollment
// rows at all (schools that never adopted the enrollment pipeline keep
// working unchanged); at a school that does use them, a row-less student is
// an unset status or a stray slot on a contact, not someone to invoice.
//
// `alias` is the students table alias in the calling query.
export function billableStudentSql(alias = 's'): string {
  return `COALESCE(
            (SELECT e.status FROM enrollments e
              WHERE e.student_id = ${alias}.id
              ORDER BY e.created_at DESC LIMIT 1),
            CASE WHEN EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.school_id = ${alias}.school_id)
                 THEN 'unset' ELSE 'enrolled' END
          ) = 'enrolled'`;
}

// A family is billable when it has at least one billable, active student.
// `familyIdExpr` is the expression that yields the family id in the calling
// query (e.g. `f.id`).
export function billableFamilySql(familyIdExpr = 'f.id'): string {
  return `EXISTS (SELECT 1 FROM students bs
                   WHERE bs.family_id = ${familyIdExpr} AND bs.status = 'active'
                     AND ${billableStudentSql('bs')})`;
}
