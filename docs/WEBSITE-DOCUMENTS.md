# Newsletters & menus on the school website

The monthly classroom newsletters, lesson plans and lunch menu on a school's
public website are published by the school itself, from the dashboard. No
developer, no deploy, no PDFs committed to the website repo.

Same shape as the photo gallery: a manager in the dashboard, a public feed,
and a few lines of JavaScript on the marketing site.

## The monthly routine, for the school

**Dashboard → Website → Newsletters & Menus**

1. Pick what you are uploading: *Classroom Newsletters & Lesson Plans*, or
   *Lunch Menus*.
2. Pick the month. It is already set to the month after whatever is up, which
   is usually the one you want.
3. Drag this month's files in. The names fill themselves in from last month's
   set, so `Maple-Tree-September-2026-NL-LP.pdf` lands on the Maple Tree card.
   Fix any that guessed wrong.
4. **Publish**.

The website shows the newest month it has, so last month's set drops off on
its own. Give it two minutes — the feed is cached that long.

Sent a corrected newsletter? Upload it again for the same classroom and the
same month. It replaces the card rather than adding a second one.

**Hide** takes a document off the public site without deleting it.
**Remove** deletes it outright.

## How it fits together

| Piece | Where |
| --- | --- |
| Manager | `app/school/[locationId]/website-documents/` |
| Upload / edit / delete | `app/api/school/website-documents/` |
| Public feed (JSON) | `GET /api/website/documents/{locationId}` |
| Public bytes | `GET /api/website/documents/file/{id}` |
| Table | `website_documents`, migration `113` |

The feed is CORS-open and returns published rows only, grouped by section and
then by month, newest month first:

```json
{ "school": { "name": "…" },
  "sections": [
    { "key": "newsletter",
      "title": "Classroom Newsletters & Lesson Plans",
      "months": [
        { "period_month": "2026-09-01", "period_label": "September 2026",
          "documents": [
            { "id": "…", "label": "Maple Tree Classroom",
              "filename": "…", "mime": "application/pdf", "size_bytes": 182334 }
          ] }
      ] }
  ] }
```

An unknown location, or a school with nothing uploaded, answers
`{ "sections": [] }` rather than an error, so a site can ship the widget
before the school's first upload.

## Wiring up another school's site

In the FLMA site (`losched16/flma-website`, `parent-resources/index.html`) the
pattern is:

- Wrap each section in `<div data-live-section="newsletter">` with a
  `[data-live-month]` span and a `[data-live-body]` container.
- Leave real markup inside. **That markup is the fallback** — it is what
  visitors see before the first upload, if the feed is unreachable, and with
  JavaScript off. It is only replaced once a section comes back with at least
  one document. Keep it current.
- The script escapes every value out of the feed before it touches the DOM.
  Labels are typed by school staff; treat them as text, never as markup.

## Why not `school_documents`

`school_documents` (migration 049) holds parent-portal documents for enrolled
families — handbooks, supply lists, forms. Those are behind a login on
purpose. A `show_on_website` flag on that table would put private material one
wrong `WHERE` clause away from the open web, so website documents get their
own table. The cost is one more upload screen, which is the right trade.
