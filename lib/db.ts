import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL env var is required');
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase pooler requires SSL
      // ── Serverless connection-pool sizing ──────────────────────────
      // DATABASE_URL points at Supabase's TRANSACTION-mode pooler
      // (port 6543). Transaction mode multiplexes statements across a
      // smaller upstream pool, so we can have many concurrent clients
      // without hitting EMAXCONNSESSION (the session-mode pooler caps
      // at 15 and we hit that limit during page-load + Link prefetch
      // storms — see lib/db.ts history).
      //
      // Caveat: transaction mode doesn't support session-level state.
      // No `SET SESSION`, no LISTEN/NOTIFY, no cross-query prepared
      // statements. node-postgres's default `.query(text, params)`
      // uses unnamed parameterized queries each time, which is fine.
      // If we ever add LISTEN/NOTIFY or named prepared statements,
      // open a dedicated direct connection — don't change this URL.
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    // The Supabase transaction-mode pooler will occasionally terminate an
    // IDLE pooled connection (pgbouncer recycle, brief network blip,
    // maintenance). node-postgres surfaces that as an 'error' event on the
    // pool object; with NO listener, Node escalates it to an unhandled
    // 'error' that can crash the process. Swallow it — the broken client is
    // already evicted from the pool, and the next query() acquires a fresh
    // one. Without this, a transient drop took down more than the one query.
    _pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] idle pooled client error (evicted, non-fatal):', err.message);
    });
  }
  return _pool;
}

// Connection-level failures that mean the statement almost certainly never
// reached Postgres (the pooler handed back a dead connection, or dropped it
// during the handshake). Safe to retry for READ queries — see query().
function isTransientConnError(e: unknown): boolean {
  const err = e as { message?: string; code?: string } | null;
  if (!err) return false;
  // SQLSTATE class 08 = connection exception; 57P0x = admin/server shutdown.
  if (err.code && /^(08|57P0)/.test(err.code)) return true;
  return !!err.message && /connection terminated|econnreset|epipe|connection closed|server closed the connection|timeout exceeded|terminating connection/i.test(err.message);
}

// Retry transient connection drops, but ONLY for read-only (SELECT)
// statements — so a write can never be double-applied. The Supabase pooler
// dropping a connection used to surface as a hard 500 (e.g. the iframe
// auto-auth "Auto-auth failed: Connection terminated unexpectedly"); a short
// retry turns that blip into a transparent re-attempt. Writes and
// transactions (withTransaction, below) are untouched.
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const isRead = /^\s*select\b/i.test(text);
  const maxAttempts = isRead ? 3 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getPool().query<T>(text, params as never);
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts && isTransientConnError(e)) {
        await new Promise((r) => setTimeout(r, attempt * 150));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function withTransaction<T>(
  fn: (q: typeof query) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txQuery = ((text: string, params?: unknown[]) =>
      client.query(text, params as never)) as typeof query;
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
