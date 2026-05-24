// Maps GHL pipeline stage names (free-text, school-specific) to the
// constrained family-graph enrollment status enum used by the admissions
// funnel widget. Returns null for stages we can't confidently map — those
// opportunities are skipped during ingestion.
//
// The mapping is heuristic: schools name their stages differently
// ("Visited" vs "Tour Booked" vs "Tour Scheduled") so we collapse each
// stage name to lowercase + spaces and check against known synonyms.

const FUNNEL_STAGES = [
  'inquiry',
  'tour_scheduled',
  'application_submitted',
  'accepted',
  'enrolled',
  'waitlisted',
  'withdrawn',
  'declined',
] as const;

type FunnelStatus = typeof FUNNEL_STAGES[number];

export function pipelineStageToFunnelStatus(stageName: string): FunnelStatus | null {
  const v = stageName.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!v) return null;

  // Direct match against the canonical names
  const collapsed = v.replace(/\s+/g, '_');
  if ((FUNNEL_STAGES as readonly string[]).includes(collapsed)) {
    return collapsed as FunnelStatus;
  }

  // Synonyms — prefer most-progressed match if a stage name implies multiple
  // (e.g., "Accepted - Awaiting Deposit" → 'accepted')
  if (/\benrolled\b|\bactive\b|\bcurrent\b|\bregistered\b/.test(v)) return 'enrolled';
  if (/\baccept|\badmit|\boffer/.test(v)) return 'accepted';
  if (/\bapplic|\bapplied/.test(v)) return 'application_submitted';
  if (/\btour|\bvisit|\bopen house\b|\bshadow/.test(v)) return 'tour_scheduled';
  if (/\binquiry|\binquired|\blead\b|\bnew\b|\binterest/.test(v)) return 'inquiry';
  if (/\bwaitlist|\bwait list\b/.test(v)) return 'waitlisted';
  if (/\bwithdr|\bunenroll/.test(v)) return 'withdrawn';
  if (/\bdeclin|\breject|\bden(y|ied)|\blost\b/.test(v)) return 'declined';

  return null;
}
