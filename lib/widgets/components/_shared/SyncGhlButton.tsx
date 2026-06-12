'use client';

// "Sync now" — on-demand refresh of this school's Growth Suite contact
// data (tags, fields, opportunities → dashboards). Posts to
// /api/school/ghl-sync, then hard-reloads so every widget on the page
// re-renders from the fresh data. The scan takes ~15-60s for a few
// hundred contacts; the button narrates so operators don't double-click.

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';

export function SyncGhlButton({ locationId }: { locationId: string }) {
  const [state, setState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  async function run() {
    if (state === 'syncing') return;
    setState('syncing');
    setError('');
    try {
      const res = await fetch('/api/school/ghl-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState('done');
      // Brief beat so the ✓ is visible, then re-render everything
      // from the refreshed data.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={state === 'syncing'}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
        state === 'error'
          ? 'border-red-300 bg-red-50 text-red-700'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
      } disabled:opacity-70`}
      title={
        state === 'error'
          ? error
          : 'Pull the latest contact data from Growth Suite right now (takes up to a minute)'
      }
    >
      <RefreshCw className={`h-3 w-3 ${state === 'syncing' ? 'animate-spin' : ''}`} />
      {state === 'syncing' ? 'Syncing… (up to 1 min)'
        : state === 'done' ? '✓ Synced — refreshing'
        : state === 'error' ? 'Sync failed — retry'
        : 'Sync now'}
    </button>
  );
}
