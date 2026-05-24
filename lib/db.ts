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
  }
  return _pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never);
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
