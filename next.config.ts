import type { NextConfig } from "next";

// Iframe-friendly CSP for /school/* routes (the school admin embed surface).
//
// Default: allow any HTTPS origin to frame /school/*. Per-school auth is
// already gated by `embed_token` (HMAC over locationId, verified in
// proxy.ts) — without a valid token the iframe just shows the 401 page,
// so allowing arbitrary parents doesn't leak data. GHL white-labeled
// agencies serve from a huge variety of custom domains and we don't want
// to play whack-a-mole maintaining an allowlist.
//
// If an operator wants to lock this down to a specific list of parent
// origins, set FRAME_ANCESTORS_OVERRIDE in env (space- or comma-
// separated). Example:
//   FRAME_ANCESTORS_OVERRIDE="'self' https://*.gohighlevel.com"

function readAncestors(): string {
  const override = process.env.FRAME_ANCESTORS_OVERRIDE?.trim();
  if (override) {
    return override.split(/[\s,]+/).filter(Boolean).join(' ');
  }
  // Wildcard — any HTTPS origin can frame us. Token gate still applies.
  return "https: 'self'";
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/school/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            // frame-ancestors supersedes X-Frame-Options.
            value: `frame-ancestors ${readAncestors()};`,
          },
          {
            // Force browsers to refetch on every navigation. The school
            // pages are operator-data and change as soon as the operator
            // hits "Sync from GHL" — caching them risks showing stale data
            // inside iframes. Also belt-and-suspenders against the case
            // where a CSP/header change doesn't take effect because the
            // browser cached the old response.
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
