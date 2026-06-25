// Shared, school-AGNOSTIC parsing of per-student GHL field keys.
//
// Two naming conventions exist in the wild and both are first-class here:
//   - numbered slot 1:  student_1_first_name   → slot 1, base "first_name"
//   - bare slot 1:       student_first_name      → slot 1, base "first_name"
//   - slots 2-4:         student_2_first_name    → slot 2, base "first_name"
//
// Nothing about a specific school is hardcoded — the slot is read off the
// key itself, so a school can name its fields either way and the dashboard
// reads whatever that location actually carries.

export function parseStudentSlotKey(key: string): { slot: number; base: string } | null {
  // student_<N>_<base>  (covers numbered slot 1 too: student_1_first_name)
  const m = /^student_(\d+)_(.+)$/.exec(key);
  if (m) {
    const base = m[2];
    return base ? { slot: parseInt(m[1], 10), base } : null;
  }
  // student_<base>  → bare slot-1 convention
  if (key.startsWith('student_')) {
    const base = key.slice('student_'.length);
    return base ? { slot: 1, base } : null;
  }
  return null;
}

// The set of slot keys to try when LOOKING UP a curated field for a given
// slot + base. Slot 1 is special: a school may use either `student_<base>`
// or `student_1_<base>`. A school only uses one of them, so trying both is
// safe (only one resolves) and removes any per-school assumption.
export function studentSlotKeyCandidates(slot: number, base: string): string[] {
  if (slot === 1) return [`student_${base}`, `student_1_${base}`];
  return [`student_${slot}_${base}`];
}
