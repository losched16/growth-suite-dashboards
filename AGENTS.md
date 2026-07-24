<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Widget UX conventions

These are non-obvious patterns the operators rely on. Apply them by default
when building or extending any dashboard widget — don't wait to be asked.

## 1. Filters auto-apply (no "Apply" button click required)

Rich widgets are URL-state-driven (server-rendered) but operators expect a
client-feeling filter experience: change a dropdown → results update; type
in a search box → press Enter → results update.

**Use `<AutoSubmitForm>`** (`lib/widgets/components/_shared/AutoSubmitForm.tsx`)
in place of `<form method="GET">` for every filter row.

- Selects / checkboxes / radios → submit on change
- Text / search inputs → submit on ENTER only. Never on a debounce: the
  server-rendered reload yanks focus mid-word (Clint, 2026-07-24). Hint
  it in the placeholder, e.g. "… — press Enter".
- AutoSubmitForm preserves the operator's scroll position across every
  filter reload (sessionStorage) — don't reimplement that per widget.
- The visible "Apply" button should be wrapped in `<noscript>` as a
  fallback only — operators never click it when JS is on.

## 2. Always carry the embed/chrome state across submits

Inside an iframe the URL has `?chrome=none` and (sometimes) `embed_token`.
Without preserving these, applying a filter unwraps the bare-mode iframe
back into the full-shell layout — confusing for users embedded inside GHL.

**In every filter form**, drop in:
```tsx
<PreserveEmbedParams current={current} />
```
**Every "clear" link** uses the helper:
```tsx
<a href={clearHref(current /*, optionally extra: { view } */)}>clear</a>
```
Both live in `lib/widgets/components/_shared/PreserveEmbedParams.tsx`.

Sort/pagination links built from `current` already preserve unknown keys
when they iterate via `Object.entries(current)` — keep that pattern.

## 3. Family / contact rows always include "Open in GHL"

Whenever a widget surfaces a parent or contact with a `ghl_contact_id`,
include a deep-link back to the GHL contact record. Operators flip
between the widget and the full CRM record constantly — without this
they have to manually search the contact in GHL.

URL pattern: `${crmAppBase}/v2/location/{locationId}/contacts/detail/{contactId}`

Use the helpers in `lib/ghl/contact-url.ts`:
```ts
import { crmAppBase, ghlContactUrl } from '@/lib/ghl/contact-url';
```

`crmAppBase()` reads `CRM_APP_BASE` env (defaults to
`https://app.gohighlevel.com`). Resolve it server-side and pass down as
a prop — client components can't read non-public env vars.

## 4. Inline accordion, not page navigation

Family / student / contact detail belongs in an **inline accordion**
opened by clicking the row, not a separate page that the operator has to
navigate to and back from. See `FamilyHubTable/AccordionTable.tsx` for the
canonical implementation. State is local (`useState`), one row open at a
time, expansion stays inside the same iframe so embedded views don't
break.
