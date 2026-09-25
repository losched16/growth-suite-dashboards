// POST /api/quiz-lead — public lead intake for the "Montessori Fit Quiz".
//
// The quiz is a static HTML page embedded on client websites (WordPress/Divi,
// GHL pages). It POSTs JSON here; we upsert the contact into the configured
// GoHighLevel location, add quiz tags via the additive tags endpoint (existing
// tags are kept), and attach a note with the full result.
//
// Single-location by design: the target location + token come from env
// (GHL_LOCATION_ID, GHL_PIT) and the token never leaves the server. CORS is an
// explicit allowlist (ALLOWED_ORIGINS, comma-separated): any other origin —
// or no Origin at all — gets 403. A hidden `website` honeypot field silently
// drops bots. GHL failures are logged server-side and surface to the client
// only as a generic 502.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const SOURCE = 'Montessori Fit Quiz';
const MAX_BODY_CHARS = 20_000;
const MAX_ANSWERS = 50;
const MAX_NOTE_CHARS = 15_000;
const GHL_TIMEOUT_MS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ─── CORS ────────────────────────────────────────────────────────────────

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

// The request's Origin if (and only if) it's on the allowlist, else null.
function matchOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return allowedOrigins().includes(origin.toLowerCase()) ? origin : null;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(body: unknown, status: number, origin?: string) {
  return NextResponse.json(body, {
    status,
    headers: origin ? corsHeaders(origin) : { Vary: 'Origin' },
  });
}

export async function OPTIONS(request: NextRequest) {
  const origin = matchOrigin(request);
  if (!origin) return new NextResponse(null, { status: 403, headers: { Vary: 'Origin' } });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// ─── Input hygiene ───────────────────────────────────────────────────────

// Coerce to a single-line, trimmed, length-limited string ('' if unusable).
// Collapsing control chars/newlines keeps client text from forging lines in
// the note we build below.
function clean(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  return s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// E.164 for GHL, or null when there aren't 10–15 digits.
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

// Tag-safe slug: "Within 3 months" → "within-3-months".
function tagSlug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

type Answer = { question: string; answer: string; value: string };

function parseAnswers(raw: unknown): Map<string, Answer> {
  const out = new Map<string, Answer>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, a] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= MAX_ANSWERS) break;
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const key = clean(id, 64);
    if (!key) continue;
    out.set(key, { question: clean(r.question, 300), answer: clean(r.answer, 500), value: clean(r.value, 100) });
  }
  return out;
}

// ─── GoHighLevel ─────────────────────────────────────────────────────────

type GhlResult = { ok: true; data: unknown } | { ok: false };

async function ghlPost(path: string, pit: string, payload: unknown): Promise<GhlResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GHL_TIMEOUT_MS);
  try {
    const res = await fetch(`${GHL_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pit}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      // Status + body only — never the request headers (they carry the token).
      console.error(`[quiz-lead] GHL POST ${path} -> ${res.status}: ${text.slice(0, 2000)}`);
      return { ok: false };
    }
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON 2xx — treat as empty */ }
    return { ok: true, data };
  } catch (e) {
    console.error(`[quiz-lead] GHL POST ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const origin = matchOrigin(request);
  if (!origin) return reply({ error: 'Forbidden' }, 403);

  const pit = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!pit || !locationId) {
    console.error('[quiz-lead] GHL_PIT and/or GHL_LOCATION_ID is not set');
    return reply({ error: 'Server not configured' }, 500, origin);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return reply({ error: 'Payload too large' }, 413, origin);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: 'Invalid JSON' }, 400, origin);
  }

  // Honeypot: real visitors never see or fill `website`. Pretend success.
  if (clean(body.website, 500)) return reply({ ok: true }, 200, origin);

  const firstName = clean(body.firstName, 100);
  const childName = clean(body.childName, 100);
  const email = clean(body.email, 254).toLowerCase();
  const phone = normalizePhone(clean(body.phone, 40));
  const matchLevel = clean(body.matchLevel, 100);
  const scoreNum = typeof body.score === 'number' ? body.score : Number(body.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : null;
  const answers = parseAnswers(body.answers);

  const errors: string[] = [];
  if (!firstName) errors.push('firstName is required');
  if (!EMAIL_RE.test(email)) errors.push('a valid email is required');
  if (!phone) errors.push('phone must have at least 10 digits');
  if (errors.length) return reply({ error: 'Invalid submission', details: errors }, 400, origin);

  // a) Upsert the contact (matched by the location's email/phone identifiers).
  const up = await ghlPost('/contacts/upsert', pit, { locationId, firstName, email, phone, source: SOURCE });
  const contactId = up.ok ? (up.data as { contact?: { id?: unknown } })?.contact?.id : undefined;
  if (typeof contactId !== 'string' || !contactId) {
    if (up.ok) console.error('[quiz-lead] upsert succeeded but returned no contact.id');
    return reply({ error: 'Could not sync lead' }, 502, origin);
  }

  // b) Tags — the dedicated endpoint ADDS, so the contact's existing tags stay.
  const tags = [SOURCE];
  const timeline = tagSlug(answers.get('timeline')?.value ?? '');
  const age = tagSlug(answers.get('age')?.value ?? '');
  if (timeline) tags.push(`quiz-timeline-${timeline}`);
  if (age) tags.push(`quiz-age-${age}`);

  // c) Note with the full result.
  const lines = ['MONTESSORI FIT QUIZ RESULT', `Match: ${matchLevel || 'n/a'}${score === null ? '' : ` (${score}%)`}`];
  if (childName) lines.push(`Child: ${childName}`);
  for (const [id, a] of answers) {
    lines.push('', a.question || id, `→ ${a.answer || a.value || '(no answer)'}`);
  }
  const note = lines.join('\n').slice(0, MAX_NOTE_CHARS);

  const id = encodeURIComponent(contactId);
  const [tagRes, noteRes] = await Promise.all([
    ghlPost(`/contacts/${id}/tags`, pit, { tags }),
    ghlPost(`/contacts/${id}/notes`, pit, { body: note }),
  ]);
  if (!tagRes.ok || !noteRes.ok) return reply({ error: 'Could not sync lead' }, 502, origin);

  console.log(`[quiz-lead] synced contact ${contactId} (${tags.length} tags, note ${note.length} chars)`);
  return reply({ ok: true }, 200, origin);
}
