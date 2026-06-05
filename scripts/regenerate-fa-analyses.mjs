// One-off script to (re)generate AI analyses for DGM's demo FA apps.
// Use:   node --env-file=.env.local scripts/regenerate-fa-analyses.mjs
//
// This duplicates the analyzer prompt from lib/ai/fa-analysis.ts so we
// don't need ts-node. Keep in sync if the prompt evolves.

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// node --env-file= leaves Claude Code's empty-string ANTHROPIC_API_KEY
// in place. Re-parse .env.local ourselves and override anything we set.
const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(here, '..', '.env.local'), 'utf8');
for (const ln of envText.split(/\r?\n/)) {
  const m = ln.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[m[1]] = v;
}

const DGM_ID = 'cfa9030d-c8fe-49ae-a9e7-f1003844ec07';
const MODEL = 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `You are an experienced financial aid committee analyst for a private K-12 school. You read families' aid applications and produce concise, fair, evidence-based committee briefings.

Your tone is warm but professional. You treat every family with dignity. You ground every claim in the data the parent submitted. You do not moralize or invent facts.

Your output is **always** a single valid JSON object matching the response_format schema below. No prose outside JSON. No code fences.

Schema:
{
  "executive_summary": string,
  "financial_snapshot": {
    "annual_income_cents": number | null,
    "annual_expenses_cents": number | null,
    "discretionary_capacity_cents": number | null,
    "savings_runway_months": number | null,
    "debt_burden_label": "low" | "moderate" | "high" | "unknown",
    "housing_burden_label": "low" | "moderate" | "high" | "unknown"
  },
  "demonstrated_need_assessment": string,
  "positives": string[],
  "concerns": string[],
  "recommended_awards": [{
    "student_id": string,
    "student_name": string,
    "unrestricted_recommended_cents": number,
    "recommended_cents": number,
    "low_cents": number,
    "high_cents": number,
    "rationale": string,
    "policy_applied": string | null
  }],
  "total_award_range": {
    "unrestricted_recommended_cents": number,
    "recommended_cents": number,
    "low_cents": number,
    "high_cents": number
  },
  "cost_of_living_assessment": string | null,
  "suggested_decision_note": string,
  "missing_documents": string[],
  "follow_up_questions": string[]
}

Guidelines:
- unrestricted_recommended_cents is your honest, data-driven number. Pretend no caps exist. Pick the specific dollar amount you'd advocate for in committee given demonstrated need + capacity.
- recommended_cents = the same number AFTER applying the school's caps:
    1. Start with unrestricted.
    2. Cap at student's current_tuition_cents.
    3. If max_award_pct_of_tuition set, cap at floor(current_tuition_cents x max_award_pct_of_tuition).
    4. If max_award_per_student_cents set, cap at that.
    5. If min_family_contribution_pct set, ensure recommended_cents <= current_tuition_cents x (1 - min_family_contribution_pct).
- When a cap reduced the number, fill policy_applied with one sentence naming the binding cap. Else null.
- Order: low_cents <= recommended_cents <= high_cents. low/high also post-cap.
- Clear demonstrated need -> generous unrestricted toward high end.
- Missing/inconsistent data -> NOTE in concerns/missing_documents and stay conservative.
- Clearly NO need -> unrestricted_recommended_cents = 0 and explain plainly.
- housing_burden_label: <30% = low, 30-40% = moderate, >40% = high, adjusted for COL multiplier.
- debt_burden_label: <15% = low, 15-30% = moderate, >30% = high (monthly debt / monthly income).
- discretionary_capacity_cents = annual income minus non-negotiable expenses.
- cost_of_living_assessment: 1-2 sentences on how COL shaped your read; null if no COL provided.
- suggested_decision_note: school voice to family, quote recommended_cents (post-cap), don't reference the cap unless helpful.`;

const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const settings = (await c.query(
  `SELECT * FROM school_financial_aid_settings WHERE school_id = $1`,
  [DGM_ID],
)).rows[0];

const apps = (await c.query(
  `SELECT a.id, a.school_id, a.family_id, a.academic_year, a.household_size, a.responses,
          f.display_name AS family_display_name, sc.name AS school_name
   FROM fa_applications a
   JOIN families f ON f.id = a.family_id
   JOIN schools sc ON sc.id = a.school_id
   WHERE a.school_id = $1 AND a.status IN ('submitted','under_review','decided')`,
  [DGM_ID],
)).rows;

console.log(`Found ${apps.length} apps to analyze`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

for (const app of apps) {
  console.log(`\n=== ${app.family_display_name} (${app.id}) ===`);
  const students = (await c.query(
    `SELECT cs.student_id, s.first_name, s.last_name, cs.current_tuition::text, cs.requested_aid::text
     FROM fa_application_students cs JOIN students s ON s.id = cs.student_id
     WHERE cs.application_id = $1`,
    [app.id],
  )).rows;
  const files = (await c.query(
    `SELECT document_type, display_name, size_bytes
     FROM fa_application_files WHERE application_id = $1`,
    [app.id],
  )).rows;

  const family = (app.responses?.family) ?? {};
  const household = (app.responses?.household) ?? {};
  const maritalStatus = family.marital_status ?? household.marital_status ?? null;

  const lines = [];
  lines.push(`# Application for review`);
  lines.push(``);
  lines.push(`**Family:** ${app.family_display_name}`);
  lines.push(`**School:** ${app.school_name}`);
  lines.push(`**Academic year:** ${app.academic_year}`);
  lines.push(`**Household size:** ${app.household_size ?? 'not provided'}`);
  lines.push(`**Marital status:** ${maritalStatus ?? 'not provided'}`);
  lines.push(``);
  lines.push(`## Students applying`);
  for (const s of students) {
    const tc = Math.round(Number(s.current_tuition ?? 0) * 100);
    const ra = Math.round(Number(s.requested_aid ?? 0) * 100);
    lines.push(`- **${s.first_name} ${s.last_name}** (student_id: ${s.student_id}) — tuition $${(tc/100).toLocaleString()}, requested aid $${(ra/100).toLocaleString()}`);
  }
  lines.push(``);
  lines.push(`## Required documents per school policy`);
  lines.push(settings.required_document_types?.length ? settings.required_document_types.join(', ') : '_(none required)_');
  lines.push(``);
  lines.push(`## Documents the parent uploaded`);
  if (files.length === 0) lines.push('_(none uploaded)_');
  else for (const d of files) lines.push(`- ${d.document_type ?? 'other'}: ${d.display_name} (${Math.round(d.size_bytes/1024)} KB)`);
  lines.push(``);
  lines.push(`## School policy caps (apply AFTER your unrestricted recommendation)`);
  const pctOrNone = (v) => (v == null ? 'not set' : `${Math.round(Number(v) * 100)}%`);
  lines.push(`- max_award_pct_of_tuition: ${pctOrNone(settings.max_award_pct_of_tuition)}`);
  lines.push(`- min_family_contribution_pct: ${pctOrNone(settings.min_family_contribution_pct)}`);
  lines.push(`- max_award_per_student_cents: $${(settings.max_award_per_student_cents / 100).toLocaleString()}`);
  if (settings.policy_notes?.trim()) {
    lines.push(`- Free-text policy notes from the school:`);
    for (const ln of settings.policy_notes.split('\n')) if (ln.trim()) lines.push(`  > ${ln.trim()}`);
  }
  lines.push(``);
  lines.push(`## Regional cost-of-living context`);
  const mult = Number(settings.regional_col_multiplier ?? 1);
  lines.push(`- COL multiplier vs US average: ${mult.toFixed(2)}× ${mult > 1.15 ? '(above average)' : mult < 0.9 ? '(below average)' : '(near US average)'}`);
  if (settings.regional_col_label) lines.push(`- Region label: ${settings.regional_col_label}`);
  lines.push(``);
  lines.push(`## Wizard responses (all 10 sections)`);
  lines.push('```json');
  lines.push(JSON.stringify(app.responses ?? {}, null, 2));
  lines.push('```');
  lines.push(``);
  lines.push(`Produce the analysis JSON now.`);

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2800,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') { console.error('  no text block'); continue; }
  const cleaned = textBlock.text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { console.error('  JSON parse failed:', e.message); console.error(cleaned.slice(0, 400)); continue; }

  await c.query(
    `UPDATE fa_applications
       SET ai_analysis = $1::jsonb,
           ai_analyzed_at = now(),
           ai_analysis_model = $2
     WHERE id = $3`,
    [JSON.stringify(parsed), MODEL, app.id],
  );

  const totUR = parsed.total_award_range?.unrestricted_recommended_cents ?? 0;
  const totR  = parsed.total_award_range?.recommended_cents ?? 0;
  const capped = totUR > totR;
  console.log(`  unrestricted $${(totUR/100).toLocaleString()} → recommended $${(totR/100).toLocaleString()}${capped ? '  ⚠ capped' : ''}`);
}

await c.end();
console.log('\nDone.');
