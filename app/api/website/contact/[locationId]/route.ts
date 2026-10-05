// POST /api/website/contact/{locationId} — the contact form and the open
// house RSVP form on a school's PUBLIC marketing website.
//
// intent=open-house is an RSVP: it carries the event date and party size,
// lands in GHL with an "Open House RSVP" tag plus one tag per event date (so a
// GHL workflow can send the confirmation and the reminder), and its message is
// optional.
//
// The enquiry is written to website_enquiries FIRST and only then pushed to
// GoHighLevel. If the push fails the row stays, the parent still gets their
// thank-you, and the enquiry can be replayed; losing a prospective family's
// message because a token expired is the one outcome worth engineering
// against.
//
// Unlike the gallery and document feeds, this endpoint WRITES, so it is not
// CORS-open. The origins allowed to post a school's form live on that
// school's own row (schools.website_origin), set per school rather than
// hard-coded here. A school with none set cannot be posted to at all.
//
// Spam: a hidden honeypot field, a minimum fill time, length caps, and a
// per-address rate limit. No CAPTCHA — a school contact form does not earn
// one, and the four together stop the drive-by bots.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { loadSchoolByLocationId, createGhlClient } from '@/lib/ghl/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_MESSAGE = 5_000;
const MAX_SHORT = 120;
const MIN_FILL_MS = 2_500;      // nobody reads and completes a form faster
const RATE_WINDOW_MIN = 10;
const RATE_MAX = 5;
const SOURCE = 'Website contact form';

const INTENTS: Record<string, string> = {
  contact: 'Website enquiry',
  application: 'Application enquiry',
  'financial-aid': 'Financial aid enquiry',
  'open-house': 'Open House RSVP',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' -> 'January 23, 2027', or null. The tag text is built here
 *  from a validated date, never taken from the page, so the public form
 *  cannot be used to write arbitrary tags into a school's CRM. */
function eventLabel(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${MONTHS[mo - 1]} ${d}, ${m[1]}`;
}

function originsFor(row: { website_origin: string | null }): string[] {
  return (row.website_origin ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
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

const clean = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

type SchoolRow = { id: string; name: string; website_origin: string | null };

async function loadAllowed(locationId: string, request: NextRequest) {
  const { rows } = await query<SchoolRow>(
    `SELECT id, name, website_origin FROM schools WHERE ghl_location_id = $1`,
    [locationId],
  );
  const school = rows[0] ?? null;
  const sent = (request.headers.get('origin') ?? '').replace(/\/+$/, '').toLowerCase();
  const origin = school && sent && originsFor(school).includes(sent) ? sent : null;
  return { school, origin };
}

export async function OPTIONS(request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  const { origin } = await loadAllowed(locationId, request);
  if (!origin) return new NextResponse(null, { status: 403, headers: { Vary: 'Origin' } });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  const { school, origin } = await loadAllowed(locationId, request);
  if (!school || !origin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { Vary: 'Origin' } });
  }
  const reply = (body: unknown, status: number) =>
    NextResponse.json(body, { status, headers: corsHeaders(origin) });

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return reply({ error: 'bad_json' }, 400); }

  // Honeypot: a field hidden from people, so anything in it came from a bot.
  // Answer 200 so the bot has nothing to learn from the difference.
  if (clean(body.website, 50)) return reply({ ok: true }, 200);

  // Fill time, measured by the page from first render to submit.
  const elapsed = Number(body.elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) {
    return reply({ ok: true }, 200);
  }

  const firstName = clean(body.first_name, MAX_SHORT);
  const lastName = clean(body.last_name, MAX_SHORT);
  const email = clean(body.email, MAX_SHORT).toLowerCase();
  const phone = clean(body.phone, 40);
  const program = clean(body.program, MAX_SHORT);
  const message = String(body.message ?? '').trim().slice(0, MAX_MESSAGE);
  const intent = INTENTS[clean(body.intent, 40)] ? clean(body.intent, 40) : 'contact';
  const isRsvp = intent === 'open-house';

  const event = clean(body.event, 10);
  const label = isRsvp ? eventLabel(event) : null;
  const party = Math.round(Number(body.party_size));
  const childAges = clean(body.child_ages, 200);

  const errors: string[] = [];
  if (!firstName) errors.push('Please tell us your first name.');
  if (!EMAIL_RE.test(email)) errors.push('Please check the email address.');
  if (isRsvp) {
    if (!label) errors.push('Please choose which open house you are coming to.');
    if (!Number.isFinite(party) || party < 1 || party > 20) errors.push('Please tell us how many are coming.');
  } else if (!message) {
    errors.push('Please add a message.');
  }
  if (errors.length) return reply({ error: errors.join(' ') }, 400);

  const details = isRsvp
    ? { event, event_label: label, party_size: party, ...(childAges ? { child_ages: childAges } : {}) }
    : null;

  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  if (ip) {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*) AS n FROM website_enquiries
        WHERE source_ip = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
      [ip, String(RATE_WINDOW_MIN)],
    );
    if (Number(rows[0]?.n ?? 0) >= RATE_MAX) {
      return reply({ error: 'That is a lot of messages in a short time. Please call us instead.' }, 429);
    }
  }

  // Record first. Everything after this point can fail without losing it.
  const { rows: saved } = await query<{ id: string }>(
    `INSERT INTO website_enquiries
       (school_id, first_name, last_name, email, phone, program, message, intent,
        details, source_origin, source_ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      school.id, firstName, lastName || null, email, phone || null,
      program || null, message || null, intent,
      details ? JSON.stringify(details) : null,
      origin, ip, clean(request.headers.get('user-agent'), 300) || null,
    ],
  );
  const enquiryId = saved[0].id;

  // Deliver to GHL. A failure here is logged on the row, not shown to the
  // parent: their message is safely stored either way.
  try {
    const row = await loadSchoolByLocationId(locationId);
    if (!row) throw new Error('school row not loadable for GHL');
    const client = createGhlClient(row);

    const up = await client.axios.post<{ contact?: { id?: string } }>('/contacts/upsert', {
      locationId: client.locationId,
      firstName,
      ...(lastName ? { lastName } : {}),
      email,
      ...(phone ? { phone } : {}),
      source: isRsvp ? 'Website open house RSVP' : SOURCE,
    });
    const contactId = up.data?.contact?.id;
    if (!contactId) throw new Error('upsert returned no contact id');

    const note = [
      isRsvp ? `OPEN HOUSE RSVP \u2014 ${label}` : INTENTS[intent].toUpperCase(),
      `From: ${firstName}${lastName ? ` ${lastName}` : ''} <${email}>`,
      phone ? `Phone: ${phone}` : null,
      isRsvp ? `Coming: ${party} ${party === 1 ? 'person' : 'people'}` : null,
      childAges ? `Children's ages: ${childAges}` : null,
      program ? `Programme of interest: ${program}` : null,
      message ? '' : null,
      message || null,
    ].filter((l) => l !== null).join('\n');

    const tags = isRsvp
      ? ['Open House RSVP', `Open House ${event}`]
      : [SOURCE, INTENTS[intent]];

    const id = encodeURIComponent(contactId);
    await Promise.all([
      client.axios.post(`/contacts/${id}/tags`, { tags }),
      client.axios.post(`/contacts/${id}/notes`, { body: note }),
    ]);

    await query(`UPDATE website_enquiries SET ghl_contact_id = $1 WHERE id = $2`, [contactId, enquiryId]);
    console.log(`[website-contact] ${school.name}: enquiry ${enquiryId} -> contact ${contactId}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await query(`UPDATE website_enquiries SET ghl_error = $1 WHERE id = $2`, [detail.slice(0, 500), enquiryId]);
    console.error(`[website-contact] ${school.name}: enquiry ${enquiryId} stored but NOT synced to GHL: ${detail}`);
  }

  return reply({ ok: true }, 200);
}
