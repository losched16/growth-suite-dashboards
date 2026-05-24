'use client';

// Tiny client island. Triggers a router.refresh() on a configurable
// interval so the widget re-runs its server-side fetch and re-renders
// with fresh data. No client-side data fetching — everything stays
// server-rendered.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  const [lastLoadedAt, setLastLoadedAt] = useState<Date>(new Date());

  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return;
    const id = setInterval(() => {
      router.refresh();
      setLastLoadedAt(new Date());
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  if (!intervalMs || intervalMs <= 0) {
    return (
      <span>
        Last loaded {lastLoadedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      </span>
    );
  }
  return (
    <span>
      Auto-refreshes every {Math.round(intervalMs / 1000)} seconds · Last loaded{' '}
      {lastLoadedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
    </span>
  );
}
