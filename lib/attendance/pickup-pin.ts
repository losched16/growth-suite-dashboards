// Kiosk PIN helpers — dashboards copy of the parent portal's
// lib/attendance/pickup-pin.ts (same DB, same PARENT_SESSION_SECRET),
// used by the office-side pickup-person manager. Keep the hashing and
// lookup EXACTLY in sync with the portal or kiosk verification breaks.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;
const PIN_LENGTH = 6;

export function generatePin(): string {
  const n = crypto.randomInt(0, 10 ** PIN_LENGTH);
  return String(n).padStart(PIN_LENGTH, '0');
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(pin, salt, SCRYPT_KEYLEN);
  return `${salt}:${buf.toString('hex')}`;
}

// Deterministic lookup digest — HMAC-SHA256(secret, school_id:pin).
// Powers O(1) kiosk lookup + the school-wide uniqueness check.
export function pinLookup(schoolId: string, pin: string): string {
  const raw = process.env.PARENT_SESSION_SECRET;
  if (!raw) throw new Error('PARENT_SESSION_SECRET env var is required');
  return crypto
    .createHmac('sha256', Buffer.from(raw, 'base64'))
    .update(`${schoolId}:${pin}`)
    .digest('hex');
}

// Chosen-PIN rules — keep identical to the portal's validateChosenPin.
const BANNED_PINS = new Set(['0000', '1234', '1111', '2222', '4321', '0123', '00000', '12345', '123456', '000000', '111111']);
export function validateChosenPin(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return 'PIN must be 4-8 digits.';
  if (BANNED_PINS.has(pin)) return 'That PIN is too easy to guess — pick something less common.';
  if (/^(\d)\1+$/.test(pin)) return 'All-same-digit PINs are not allowed.';
  return null;
}
