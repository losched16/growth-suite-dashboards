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
  // Per-student recommendation as a range.
  recommended_awards: Array<{
    student_id: string;
    student_name: string;
    low_cents: number;
    high_cents: number;
    rationale: string;
  }>;
  total_award_range: { low_cents: number; high_cents: number };
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
    "low_cents": number,                                // low end of recommended award range
    "high_cents": number,                               // high end
    "rationale": string                                 // 1-2 sentence reasoning
  }],
  "total_award_range": {
    "low_cents": number,
    "high_cents": number
  },
  "suggested_decision_note": string,                    // 3-5 sentences drafted to send to the family. Warm + clear.
  "missing_documents": string[],                        // any required docs the family didn't upload, by friendly label
  "follow_up_questions": string[]                       // 0-4 things the committee may want to ask before deciding
}

Guidelines:
- The recommended award range should be conservative on the low end and generous on the high end so the committee has room to debate.
- Cap any single student's high_cents at the student's current_tuition_cents (don't recommend awarding more than they owe).
- If documented data is missing or inconsistent, NOTE it in concerns/missing_documents instead of guessing.
- If the family is clearly in financial distress (income < expenses, no savings, high debt), say so plainly.
- If the family is clearly NOT in need (income substantially exceeds expenses, large liquid assets, low debt), recommend low_cents = 0 and explain in the rationale.
- For housing_burden_label: <30% of income = low, 30-40% = moderate, >40% = high. Calculate from monthly housing cost × 12 vs annual income.
- For debt_burden_label: total monthly debt service ÷ monthly income. <15% = low, 15-30% = moderate, >30% = high.
- discretionary_capacity_cents is annual income minus annual non-negotiable expenses (housing, debt service, taxes, basic insurance, childcare, medical). It's the family's "real" capacity to pay tuition. If negative, the family is running a deficit before tuition.`;

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
    max_tokens: 2048,
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
