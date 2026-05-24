// Tiny in-memory TTL cache for widget data fetches. Per brief §14.4.
//
// In Vercel serverless, each function invocation gets its own process.
// Cache lives only for the duration of one process, which is fine for the
// 60s page-reload cadence — repeated widget reads inside the same render
// hit the same instance. Cross-invocation we eat the API cost; that's OK
// for v1. Upgrade to Redis (Upstash) if hit rate becomes a problem.

const TTL_MS = 60_000;

interface Entry {
  value: unknown;
  expires_at: number;
}

const cache = new Map<string, Entry>();

export async function memo<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires_at > now) {
    return hit.value as T;
  }
  const value = await fetcher();
  cache.set(key, { value, expires_at: now + TTL_MS });
  return value;
}

// Stable hash of a config object for cache keying. Object key order is
// consistent within a runtime; JSON.stringify is fine.
export function hashConfig(config: unknown): string {
  return JSON.stringify(config ?? null);
}

// Test-only — clear the cache (used in dev to force a fresh fetch).
export function clearCache(): void {
  cache.clear();
}
