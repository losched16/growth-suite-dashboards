import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

// Service-to-service auth: every /api/v1/* route checks for a bearer
// token equal to INTERNAL_API_TOKEN (shared across the platform).

export function checkServiceAuth(request: Request): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return false;

  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length).trim();

  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
