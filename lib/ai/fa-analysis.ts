// Claude-powered FA application analysis.
//
// Given a fa_applications row + its responses JSONB + per-student
// requests + uploaded-doc metadata, ask Claude to return a structured
// committee-facing analysis (summary + signals + per-student award
// range + suggested decision note).
//
// We use prompt caching so re-running on the same application within
// a few minutes is fast + cheap. Results are persisted on the
// fa_applications.ai_analysis column by the caller.

import Anthropic from '@anthropic-ai/sdk';

// Sonnet 4.7 (latest 1M-context flagship) — Claude reads ~3KB of
// structured FA data and writes ~1.5KB. ~$0.02/analysis at current
// pricing. Drop to claude-haiku-4-5 for 5x cheaper if budget pressure.
const MODEL = 'claude-sonnet-4-5';

export interface FaAnalysisInput {
  family_display_name: string;
  household_size: number | null;
  marital_status: string | null;
  academic_year: string;
  // Per-student requests
  students: Array<{
    student_id: string;
    first_name: string;
    last_name: string;
    current_tuition_cents: number;
    requested_aid_cents: number;
  }>;
  // The 10-section wizard responses, passed through verbatim.
  responses: Record<string, unknown>;
  // Document metadata (filenames + types). We do NOT pass file
  // contents — that would balloon tokens and lock us into vision
  // mode. Doc list is a SIGNAL ("uploaded a tax return, missing
  // bank statement").
  documents: Array<{ document_type: string | null; filename: string; size_bytes: number }>;
  // School-side context
  school_name: string;
  required_document_types: string[];
  // School policy caps the AI applies AFTER its unrestricted
  // recommendation. NULL = no cap. Fractions (0.50 = 50%).
  max_award_pct_of_tuition: number | null;
  min_family_contribution_pct: number | null;
  max_award_per_student_cents: number;
  policy_notes: string | null;
  // Regional cost-of-living signal. 1.0 = US average. Used by Claude
  // to sanity-check the family's reported expenses against what's
  // reasonable for the school's region.
  regional_col_multiplier: number;
  regional_col_label: string | null;
}

export interface FaAnalysisResult {
  executive_summary: string;
  financial_snapshot: {
    annual_income_cents: number | null;
    annual_expenses_cents: number | null;
    discretionary_capacity_cents: number | null;
    savings_runway_months: number | null;
    debt_burden_label: 'low' | 'moderate' | 'high' | 'unknown';
    housing_burden_label: 'low' | 'moderate' | 'high' | 'unknown';
  };
  demonstrated_need_assessment: string;
  positives: string[];
  concerns: string[];
  // Per-student recommendation: a specific number Claude believes is
  // right, with a low/high range bracketing it so the committee has
  // room to negotiate up or down. unrestricted_* is what Claude would
  // recommend with NO policy caps applied — recommended_cents is the
  // ACTUAL number after the school's caps are applied. They differ
  // only when a cap binds.
  recommended_awards: Array<{
    student_id: string;
    student_name: string;
    unrestricted_recommended_cents: number; // pre-cap, pure data-driven
    recommended_cents: number;     // post-cap — what the committee should offer
    low_cents: number;             // committee debate floor (post-cap)
    high_cents: number;            // committee debate ceiling (post-cap)
    rationale: string;             // why this specific number
    policy_applied: string | null; // explanation if a cap reduced the recommendation
  }>;
  total_award_range: {
    unrestricted_recommended_cents: number; // sum of per-student unrestricted
    recommended_cents: number;     // sum of per-student recommended (post-cap)
    low_cents: number;
    high_cents: number;
  };
  // Free-text on how COL was factored in, if at all.
  cost_of_living_assessment: string | null;
  suggested_decision_note: string;
  // What documents are missing / look stale, if any.
  missing_documents: string[];
  // Free-form flags the committee should look at first.
  follow_up_questions: string[];
}

const SYSTEM_PROMPT = `You are an experienced financial aid committee analyst for a private K-12 school. You read families' aid applications and produce concise, fair, evidence-based committee briefings.

Your tone is warm but professional. You treat every family with dignity. You ground every claim in the data the parent submitted. You do not moralize or invent facts.

Your output is **always** a single valid JSON object matching the response_format schema below. No prose outside JSON. No code fences.

Schema:
{
  "executive_summary": string,                          // 2-3 sentences. Family at a glance.
  "financial_snapshot": {
    "annual_income_cents": number | null,               // total gross income, all sources, in cents
    "annual_expenses_cents": number | null,             // total annual expenses + housing + debt service, in cents
    "discretionary_capacity_cents": number | null,      // income minus essential expenses, in cents (can be negative)
    "savings_runway_months": number | null,             // liquid assets / monthly essential expenses
    "debt_burden_label": "low" | "moderate" | "high" | "unknown",
    "housing_burden_label": "low" | "moderate" | "high" | "unknown"
  },
  "demonstrated_need_assessment": string,               // 2-4 sentences explaining why this family has/lacks demonstrated need
  "positives": string[],                                // 2-5 bullets. Things that strengthen the family's case.
  "concerns": string[],                                 // 0-5 bullets. Yellow flags the committee should weigh.
  "recommended_awards": [{
    "student_id": string,                               // EXACT student_id passed in input.students[].student_id
    "student_name": string,
    "unrestricted_recommended_cents": number,           // YOUR pure data-driven number, BEFORE applying school policy caps
    "recommended_cents": number,                        // The same number AFTER applying the school's policy caps (see below). When no cap binds, equals unrestricted_recommended_cents.
    "low_cents": number,                                // floor of the debate range, post-cap
    "high_cents": number,                               // ceiling of the debate range, post-cap
    "rationale": string,                                // 2-3 sentences explaining your specific unrestricted number — what it covers, what it leaves the family responsible for
    "policy_applied": string | null                     // if recommended_cents < unrestricted, one sentence naming the cap that bound (e.g. "Reduced from $14,000 to $10,000 by school's 50% of tuition cap.") — otherwise null
  }],
  "total_award_range": {
    "unrestricted_recommended_cents": number,           // sum of per-student unrestricted_recommended_cents
    "recommended_cents": number,                        // sum of per-student recommended_cents
    "low_cents": number,
    "high_cents": number
  },
  "cost_of_living_assessment": string | null,           // 1-2 sentences on how the regional COL signal shaped your read of the family's expenses (null if no COL context was provided)
  "suggested_decision_note": string,                    // 3-5 sentences drafted to send to the family. Warm + clear. Quote the recommended_cents (post-cap) number, NOT the unrestricted number.
  "missing_documents": string[],                        // any required docs the family didn't upload, by friendly label
  "follow_up_questions": string[]                       // 0-4 things the committee may want to ask before deciding
}

Guidelines:
- **unrestricted_recommended_cents is your honest, data-driven number** — pretend the school has no policy caps. Pick the specific dollar amount you'd advocate for at the committee table if the only consideration were demonstrated need + the family's capacity to pay.
- **recommended_cents is the same number AFTER applying the school's policy caps** (described below). Compute it in this order:
    1. Start with unrestricted_recommended_cents.
    2. Cap at the student's current_tuition_cents (never award more than they owe).
    3. If max_award_pct_of_tuition is set, cap at floor(current_tuition_cents × max_award_pct_of_tuition).
    4. If max_award_per_student_cents is set, cap at that ceiling.
    5. If min_family_contribution_pct is set, ensure the family pays at LEAST that fraction of tuition — i.e. recommended_cents ≤ current_tuition_cents × (1 - min_family_contribution_pct).
    6. The result is recommended_cents.
- When a cap reduced your number, fill policy_applied with one sentence naming the binding cap (e.g. "Reduced from $14,000 to $10,000 by school's 50%-of-tuition policy cap.") — otherwise policy_applied = null.
- Order: low_cents ≤ recommended_cents ≤ high_cents. Both low_cents and high_cents are post-cap (apply the same cap chain to your range).
- If the family has clear demonstrated need, your unrestricted number should be generous toward the high end of plausible — your job is to advocate for the family's case.
- If documented data is missing or inconsistent, NOTE it in concerns/missing_documents and pick a conservative number based on what IS documented (don't refuse to recommend).
- If the family is clearly in financial distress (income < expenses, no savings, high debt), recommend strong support.
- If the family is clearly NOT in need (income substantially exceeds expenses, large liquid assets, low debt), unrestricted_recommended_cents = 0 and explain plainly in the rationale.
- For housing_burden_label: <30% of income = low, 30-40% = moderate, >40% = high. Calculate from monthly housing cost × 12 vs annual income. **Adjust the threshold for the regional COL signal** (a 35% housing burden in a 1.6× COL region like the Bay Area is closer to "moderate"; the same burden in a 0.85× rural area is "high").
- For debt_burden_label: total monthly debt service ÷ monthly income. <15% = low, 15-30% = moderate, >30% = high.
- discretionary_capacity_cents is annual income minus annual non-negotiable expenses (housing, debt service, taxes, basic insurance, childcare, medical). It's the family's "real" capacity to pay tuition. If negative, the family is running a deficit before tuition.
- cost_of_living_assessment: 1-2 plain-English sentences saying how the COL multiplier shaped your read of their expenses (e.g. "Phoenix metro is 1.15× the US average — the family's $1,950 housing cost is below typical for a 4-person household here, so housing burden is genuinely low, not artificially suppressed."). If no COL context was provided (no label, multiplier ≈ 1.0), set this to null.
- suggested_decision_note: speak in the school's voice to the family. Quote the recommended_cents (post-cap) total — never the unrestricted number. Don't reference the cap explicitly to the family unless it would help them understand the offer.`;

function buildUserMessage(input: FaAnalysisInput): string {
  const lines: string[] = [];
  lines.push(`# Application for review`);
  lines.push(``);
  lines.push(`**Family:** ${input.family_display_name}`);
  lines.push(`**School:** ${input.school_name}`);
  lines.push(`**Academic year:** ${input.academic_year}`);
  lines.push(`**Household size:** ${input.household_size ?? 'not provided'}`);
  lines.push(`**Marital status:** ${input.marital_status ?? 'not provided'}`);
  lines.push(``);
  lines.push(`## Students applying`);
  for (const s of input.students) {
    lines.push(`- **${s.first_name} ${s.last_name}** (student_id: ${s.student_id}) — tuition $${(s.current_tuition_cents / 100).toLocaleString()}, requested aid $${(s.requested_aid_cents / 100).toLocaleString()}`);
  }
  lines.push(``);
  lines.push(`## Required documents per school policy`);
  lines.push(input.required_document_types.length === 0 ? '_(none required)_' : input.required_document_types.join(', '));
  lines.push(``);
  lines.push(`## School policy caps (apply AFTER your unrestricted recommendation)`);
  const pctOrNone = (v: number | null) => (v == null ? 'not set' : `${Math.round(v * 100)}%`);
  lines.push(`- max_award_pct_of_tuition: ${pctOrNone(input.max_award_pct_of_tuition)}`);
  lines.push(`- min_family_contribution_pct: ${pctOrNone(input.min_family_contribution_pct)}`);
  lines.push(`- max_award_per_student_cents: $${(input.max_award_per_student_cents / 100).toLocaleString()}`);
  if (input.policy_notes && input.policy_notes.trim()) {
    lines.push(`- Free-text policy notes from the school:`);
    for (const line of input.policy_notes.split('\n')) {
      if (line.trim()) lines.push(`  > ${line.trim()}`);
    }
  }
  lines.push(``);
  lines.push(`## Regional cost-of-living context`);
  lines.push(`- COL multiplier vs US average: ${input.regional_col_multiplier.toFixed(2)}× ${
    input.regional_col_multiplier > 1.15 ? '(above average)' :
    input.regional_col_multiplier < 0.9 ? '(below average)' : '(near US average)'
  }`);
  if (input.regional_col_label) lines.push(`- Region label: ${input.regional_col_label}`);
  lines.push(``);
  lines.push(`## Documents the parent uploaded`);
  if (input.documents.length === 0) {
    lines.push('_(none uploaded)_');
  } else {
    for (const d of input.documents) {
      lines.push(`- ${d.document_type ?? 'other'}: ${d.filename} (${Math.round(d.size_bytes / 1024)} KB)`);
    }
  }
  lines.push(``);
  lines.push(`## Wizard responses (all 10 sections)`);
  lines.push('```json');
  lines.push(JSON.stringify(input.responses, null, 2));
  lines.push('```');
  lines.push(``);
  lines.push(`Produce the analysis JSON now.`);
  return lines.join('\n');
}

export async function analyzeApplication(input: FaAnalysisInput): Promise<{ result: FaAnalysisResult; model: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is required for FA AI analysis');

  const client = new Anthropic({ apiKey });
  const userMessage = buildUserMessage(input);

  // We use cache_control on the system prompt so re-runs across
  // different applications within 5 min reuse the cached system
  // tokens (saves ~80% on system-prompt cost during a review session).
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2800,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((c) => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude response did not contain a text block');
  }
  const raw = textBlock.text.trim();

  // Defensive: model might wrap in ```json fences despite the prompt
  // saying not to. Strip them if present.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed: FaAnalysisResult;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${(e as Error).message}\n\n--- raw output ---\n${raw}`);
  }

  // Light shape validation — if the model omitted any required key,
  // surface that early instead of crashing the renderer downstream.
  for (const k of ['executive_summary','financial_snapshot','positives','concerns','recommended_awards','total_award_range','suggested_decision_note'] as const) {
    if (!(k in parsed)) throw new Error(`Claude analysis missing required field: ${k}`);
  }

  return { result: parsed, model: MODEL };
}
