// AI-assisted form import. Turns a school's existing form (a PDF, or a public
// Google Form link) into a DRAFT portal form's field_schema, which the school
// then refines in the builder and publishes. Claude produces a first-draft set
// of blocks in our exact field_schema shape; sanitizeSchema hardens the output
// so a hallucinated field can never reach the builder/renderer.
//
// We deliberately DON'T guess prefill / GHL field mappings here — those are
// school-specific and are set in the builder's "connect to Growth Suite field"
// picker after import.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-5';

// The block types the builder + parent renderer support (FormBuilderV2.tsx).
const ALLOWED_TYPES = new Set([
  'section', 'paragraph', 'text', 'textarea', 'email', 'tel', 'number',
  'date', 'select', 'radio', 'checkbox', 'signature_typed',
]);
const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox']);
const ALLOWED_CATEGORIES = new Set([
  'registration', 'medical', 'permission', 'trip', 'release', 'other',
]);

export interface ImportedBlock {
  type: string;
  key?: string;
  label?: string;
  text?: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  visible_when?: { field: string; equals: string[] };
}

export interface ImportedForm {
  name: string;
  category: string;
  field_schema: ImportedBlock[];
}

const SYSTEM_PROMPT = `You convert a school's existing form into a structured JSON definition for a parent-facing web form builder. You are given the source form (a PDF document, or the questions of a Google Form). Reproduce it faithfully as editable web-form fields.

Output a SINGLE valid JSON object, no prose, no code fences:
{
  "name": string,                 // a short, human title for the form, taken from the source (e.g. "Field Trip Permission")
  "category": "registration" | "medical" | "permission" | "trip" | "release" | "other",
  "field_schema": Block[]         // the fields, in the source's order
}

Each Block is one of these shapes. Use ONLY these "type" values:
- { "type": "section", "label": string }                         // a heading that groups the fields below it
- { "type": "paragraph", "text": string }                        // instructional text / intro / legal language
- { "type": "text", "key": string, "label": string, "required"?: boolean, "placeholder"?: string }        // short answer
- { "type": "textarea", "key": string, "label": string, "required"?: boolean }                            // long answer
- { "type": "email", "key": string, "label": string, "required"?: boolean }
- { "type": "tel", "key": string, "label": string, "required"?: boolean }                                 // phone
- { "type": "number", "key": string, "label": string, "required"?: boolean }
- { "type": "date", "key": string, "label": string, "required"?: boolean }
- { "type": "select", "key": string, "label": string, "required"?: boolean, "options": [{ "value": string, "label": string }] }   // dropdown
- { "type": "radio", "key": string, "label": string, "required"?: boolean, "options": [...] }             // pick one
- { "type": "checkbox", "key": string, "label": string, "required"?: boolean, "options": [...] }          // check all that apply / a single acknowledgement
- { "type": "signature_typed", "key": string, "label": string, "required"?: boolean }                     // a signature line

CRITICAL — COPY ALL HUMAN-VISIBLE TEXT VERBATIM:
- Every piece of visible text — field labels, section headings, instructions, intro/policy/consent/medical/liability language, and every option label — MUST be copied EXACTLY from the source, word for word, including the original wording, punctuation, capitalization, spelling, and numbering.
- Do NOT reword, paraphrase, summarize, shorten, expand, rephrase, translate, correct spelling or grammar, modernize, or "clean up" ANY text. Even if the source has a typo or awkward phrasing, reproduce it EXACTLY as written.
- Do NOT add any sentence, heading, label, option, help text, or instruction that is not present in the source.
- Do NOT omit, drop, or truncate any text that is present in the source. Long legal/consent paragraphs must be reproduced in full.
- These are real legal forms whose exact language is binding. Faithful, verbatim reproduction is mandatory. The ONLY things you generate are the internal "key" identifiers, the "value" strings for options, and the "type" mapping — you NEVER generate or alter any human-visible text.

Rules:
- "key" is a short snake_case identifier unique within the form, derived from the label (e.g. "student_name", "emergency_contact_phone"). section/paragraph blocks have NO key. (The key is internal — it is the one thing you invent; the label stays verbatim.)
- Map the source's field types sensibly: short answer→text, long answer/comments→textarea, email→email, phone→tel, a single date→date, "choose one"→radio (or select if there are many options), "check all"→checkbox, a signature line→signature_typed, an acknowledgement checkbox ("I agree…")→checkbox with a single option. Choosing the type does NOT let you change the label text.
- Reproduce dropdown/multiple-choice OPTION LABELS exactly as written (verbatim). option value = a snake_case of the label (the value is internal).
- Reproduce section headings and ALL intro/instructions/legal text as section/paragraph blocks, verbatim and complete, in the source's order and position.
- Mark a field "required": true only when the source clearly indicates it (asterisk, "required", or it's obviously essential like the student's name / a signature). This is metadata, not text — it never changes any wording.
- Only add "visible_when" if the source EXPLICITLY shows conditional logic (e.g. "If yes, explain:" following a yes/no question). Reference the controlling field's key and the value that reveals it. When unsure, omit it — the school adds conditional logic in the builder.
- Do NOT invent fields that aren't in the source. Do NOT add prefill or GHL mappings — the school sets those after import.
- If the source is unreadable or clearly not a form, return field_schema as an empty array and name "Imported form".`;

// Normalize + harden the model output so nothing invalid reaches the builder.
function sanitizeSchema(raw: unknown): ImportedBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedBlock[] = [];
  const usedKeys = new Set<string>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    const type = String(b.type ?? '').trim();
    if (!ALLOWED_TYPES.has(type)) continue;

    const block: ImportedBlock = { type };

    if (type === 'paragraph') {
      block.text = String(b.text ?? b.label ?? '').slice(0, 12000);
      if (!block.text.trim()) continue;
      out.push(block);
      continue;
    }
    if (type === 'section') {
      block.label = String(b.label ?? b.text ?? 'Section').slice(0, 800);
      out.push(block);
      continue;
    }

    // Field blocks need a unique key + a label.
    const label = String(b.label ?? '').slice(0, 1500).trim() || 'Field';
    let key = slug(String(b.key ?? '') || label) || 'field';
    for (let i = 2; usedKeys.has(key); i++) key = `${slug(String(b.key ?? '') || label) || 'field'}_${i}`;
    usedKeys.add(key);
    block.key = key;
    block.label = label;
    if (b.required === true) block.required = true;
    if (typeof b.placeholder === 'string' && b.placeholder.trim()) block.placeholder = b.placeholder.slice(0, 400);
    if (typeof b.help === 'string' && b.help.trim()) block.help = b.help.slice(0, 1500);

    if (CHOICE_TYPES.has(type)) {
      const opts = Array.isArray(b.options) ? b.options : [];
      const cleaned = opts
        .map((o) => {
          const oo = (o && typeof o === 'object') ? o as Record<string, unknown> : { label: String(o) };
          const lbl = String(oo.label ?? oo.value ?? '').slice(0, 600).trim();
          if (!lbl) return null;
          return { value: slug(String(oo.value ?? '') || lbl) || 'option', label: lbl };
        })
        .filter((o): o is { value: string; label: string } => o !== null);
      // A choice field with no options is useless — give it a placeholder option
      // (the school fills real ones in the builder) rather than dropping the field.
      block.options = cleaned.length > 0 ? cleaned : [{ value: 'option_1', label: 'Option 1' }];
    }

    // Conditional logic — only keep a well-formed rule referencing a real key.
    const vw = b.visible_when as { field?: unknown; equals?: unknown } | undefined;
    if (vw && typeof vw.field === 'string' && Array.isArray(vw.equals)) {
      block.visible_when = {
        field: slug(vw.field),
        equals: vw.equals.map((v) => String(v)).slice(0, 20),
      };
    }

    out.push(block);
  }
  return out;
}

function extractTextBlock(response: Anthropic.Message): string {
  const t = response.content.find((c) => c.type === 'text');
  if (!t || t.type !== 'text') throw new Error('Claude response had no text block');
  return t.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function finalize(rawJson: string): ImportedForm {
  let parsed: { name?: unknown; category?: unknown; field_schema?: unknown };
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`The AI returned an unreadable result. ${(e as Error).message}`);
  }
  const name = (typeof parsed.name === 'string' && parsed.name.trim()) ? parsed.name.trim().slice(0, 120) : 'Imported form';
  const category = (typeof parsed.category === 'string' && ALLOWED_CATEGORIES.has(parsed.category)) ? parsed.category : 'other';
  const field_schema = sanitizeSchema(parsed.field_schema);
  return { name, category, field_schema };
}

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is required for form import');
  return new Anthropic({ apiKey });
}

// ── PDF ──────────────────────────────────────────────────────────────────
export async function parseFormFromPdf(base64Pdf: string): Promise<ImportedForm> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0, // deterministic + verbatim — no creative rewording
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
        { type: 'text', text: 'Convert this form into the field_schema JSON described in the system prompt. Reproduce every field, section, and instruction in order. Output only the JSON object.' },
      ],
    }],
  });
  return finalize(extractTextBlock(response));
}

// ── Google Form ────────────────────────────────────────────────────────────
// A public Google Form embeds all its questions in a JS blob named
// FB_PUBLIC_LOAD_DATA_. We extract that blob and let Claude structure it (it's
// a deeply-nested positional array — Claude parses it far more robustly than a
// brittle hand-written parser would).
export async function parseFormFromGoogleForm(url: string): Promise<ImportedForm> {
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GrowthSuite/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    throw new Error(`Couldn't open that Google Form link (${(e as Error).message}). Make sure it's shared publicly, or upload a PDF instead.`);
  }

  const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);/);
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (!m) {
    throw new Error("That doesn't look like a public Google Form. Open the form, click Send → the link icon, copy that link — or upload a PDF instead.");
  }
  // Cap the blob so a huge form can't blow the token budget.
  const blob = m[1].slice(0, 120_000);
  const title = titleMatch ? titleMatch[1].replace(/\s*-\s*Google Forms\s*$/i, '').trim() : '';

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0, // deterministic + verbatim — no creative rewording
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `This is the internal data array (FB_PUBLIC_LOAD_DATA_) of a Google Form${title ? ` titled "${title}"` : ''}. Each question is a nested array — the question text is a string, and the type/options follow. Convert it into the field_schema JSON described in the system prompt, preserving question order and options.\n\n${blob}`,
    }],
  });
  const result = finalize(extractTextBlock(response));
  if (result.name === 'Imported form' && title) result.name = title.slice(0, 120);
  return result;
}
