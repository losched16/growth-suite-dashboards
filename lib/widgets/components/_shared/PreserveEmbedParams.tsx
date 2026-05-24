// Hidden inputs that survive a GET form submit, used in every widget's
// filter form. Without these, applying a filter inside an iframe would
// drop `chrome=none` (re-showing the school sidebar) and `embed_token`
// (which is normally redundant once a session cookie exists, but is
// preserved for parity with the URL the operator originally pasted into
// GHL).
//
// Drop this component anywhere inside a `method="GET"` form that passes
// `current` (WidgetSearchParams) through.

import type { WidgetSearchParams } from '@/lib/widgets/types';

const AMBIENT_KEYS = ['chrome', 'embed_token'] as const;

export function PreserveEmbedParams({ current }: { current: WidgetSearchParams }) {
  return (
    <>
      {current.chrome ? <input type="hidden" name="chrome" value={current.chrome} /> : null}
      {current.embed_token ? <input type="hidden" name="embed_token" value={current.embed_token} /> : null}
    </>
  );
}

// Build a "clear filters" href that preserves ambient embed/chrome state.
// Without this, the "clear" link would unwrap a bare-mode iframe by
// dropping `chrome=none` along with the filters the user actually wanted
// to clear. `extra` keys are kept in addition to the ambient set —
// useful for widget-specific state that shouldn't be cleared (e.g.
// StudentRosterRich's `view` toggle).
export function clearHref(
  current: WidgetSearchParams,
  extra: Record<string, string | undefined> = {},
): string {
  const p = new URLSearchParams();
  for (const k of AMBIENT_KEYS) {
    const v = current[k];
    if (v) p.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v) p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : '?';
}
