// Derive arrival_time / departure_time from a combined "schedule times" field.
//
// Many schools record the school-day window as a single GHL contact field —
// "Student Schedule Times", e.g. "8:45am - 11:45am" — but the tuition-agreement
// and DHS forms prefill `arrival_time` and `departure_time` as two SEPARATE
// students.metadata keys. Without this, those two keys are only set at import
// time and never move again, so a full↔half-day (or any hours) change made on
// the GHL contact updated `schedule_times` but left the forms prefilling stale
// arrival/departure times.
//
// This runs on every GHL→metadata path (real-time webhook, attributes cron,
// and the snapshot full rebuild) so the change flows to the forms with no
// manual edit. It only ever FILLS A GAP: a school that syncs its own explicit
// arrival_time / departure_time fields always wins — a derived value never
// overwrites one that was synced directly.

// Split "8:45am - 11:45am" (also "8:45am–11:45am" or "8:00 to 4:30") into
// [arrival, departure]. Returns null unless it cleanly yields exactly two
// non-empty parts, so a lone time or an odd format is left untouched.
const RANGE_SPLIT = /\s*(?:–|—|-|\bto\b)\s*/i;

export function splitScheduleTimes(combined: string | null | undefined): [string, string] | null {
  if (!combined) return null;
  const parts = combined.split(RANGE_SPLIT).map((p) => p.trim()).filter(Boolean);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

// Map<base,value> variant — used by the webhook + attributes-cron paths, where
// each synced field's own value is put in the map first. Fills arrival_time /
// departure_time only when the map doesn't already carry them (explicit wins).
export function deriveScheduleTimesIntoMap(map: Map<string, string>): void {
  const split = splitScheduleTimes(map.get('schedule_times'));
  if (!split) return;
  if (!map.has('arrival_time')) map.set('arrival_time', split[0]);
  if (!map.has('departure_time')) map.set('departure_time', split[1]);
}

// Returns just the derived { arrival_time, departure_time } (or {}), for the
// snapshot builder to spread FIRST — i.e. at the lowest precedence — so any
// explicit arrival/departure captured from the contact overrides it. Reads the
// combined field from the first source that carries it.
export function derivedScheduleTimes(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  let range = '';
  for (const src of sources) {
    if (src && src['schedule_times']) { range = src['schedule_times']; break; }
  }
  const split = splitScheduleTimes(range);
  return split ? { arrival_time: split[0], departure_time: split[1] } : {};
}
