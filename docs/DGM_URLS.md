# Desert Garden Montessori — URL Master List

Quick reference for every Growth Suite URL DGM uses. Use this for sharing
with Lexi/teachers, configuring GHL Custom Menu Links, or for demos.

## Core IDs

| What | Value |
|---|---|
| Production app base | `https://growth-suite-dashboards.vercel.app` |
| Parent portal base | `https://growth-suite-parent-portal.vercel.app` |
| GHL CRM base | `https://app.gohighlevel.com` |
| `ghl_location_id` (for `/school/...` URLs) | `wy1qNRECEgy8lg8pKqm0` |
| `school_id` (for `/admin/...` URLs) | `cfa9030d-c8fe-49ae-a9e7-f1003844ec07` |

Convention: append `?chrome=none` on any URL embedded inside a GHL iframe
(strips the Growth Suite sidebar). Drop it for standalone browser visits.

---

## Demo / test logins

| Account | Credentials | Use for |
|---|---|---|
| Demo parent (Michelle) | `michellelynnpt@gmail.com` / `dgm-demo-2026` | End-to-end parent portal walkthroughs at `parent-portal.vercel.app` |
| Operator (you) | Your magic-link login at `/login` | Admin side of the dashboards app |
| Teacher identity | Cookie-based picker on `/staff-requests` | No password — teachers self-identify from the DGM staff dropdown |

---

## Teacher / classroom hubs

Each classroom hub shows roster, attendance, hot lunch list, allergies,
docs, and the tab bar (Roster / Submit Request / My Requests / Documents
/ Lunch Roster / Menus).

| Hub | URL (embedded) |
|---|---|
| Classroom 1 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-1?chrome=none` |
| Classroom 2 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-2?chrome=none` |
| Classroom 3 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-3?chrome=none` |
| Classroom 4 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-4?chrome=none` |
| Classroom 5 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-5?chrome=none` |
| Classroom 6 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-6?chrome=none` |
| Classroom 7 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-7?chrome=none` |
| Classroom 8 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-8?chrome=none` |
| Classroom 10 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-10?chrome=none` |
| Classroom 11 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-11?chrome=none` |
| Classroom 12 | `/school/wy1qNRECEgy8lg8pKqm0/classroom-12?chrome=none` |
| 05 Upper Elementary Hub | `/school/wy1qNRECEgy8lg8pKqm0/program-05-upper-el?chrome=none` |
| 06 MY/HS Hub | `/school/wy1qNRECEgy8lg8pKqm0/program-06-my-hs?chrome=none` |

---

## School-wide hubs (admin / leadership dashboards)

| Dashboard | URL (embedded) |
|---|---|
| Family Hub | `/school/wy1qNRECEgy8lg8pKqm0/family-hub?chrome=none` |
| Student Roster (all students) | `/school/wy1qNRECEgy8lg8pKqm0/student-roster?chrome=none` |
| Rosters Hub | `/school/wy1qNRECEgy8lg8pKqm0/rosters-hub?chrome=none` |
| Attendance | `/school/wy1qNRECEgy8lg8pKqm0/attendance?chrome=none` |
| Documents (all students) | `/school/wy1qNRECEgy8lg8pKqm0/documents?chrome=none` |
| Document Tracker | `/school/wy1qNRECEgy8lg8pKqm0/document-tracker?chrome=none` |
| Enrollment Hub | `/school/wy1qNRECEgy8lg8pKqm0/enrollment-hub?chrome=none` |
| Admissions Tracker | `/school/wy1qNRECEgy8lg8pKqm0/admissions-tracker?chrome=none` |
| Portal Forms | `/school/wy1qNRECEgy8lg8pKqm0/portal-forms?chrome=none` |
| Finance | `/school/wy1qNRECEgy8lg8pKqm0/finance?chrome=none` |
| Financial Aid | `/school/wy1qNRECEgy8lg8pKqm0/financial-aid?chrome=none` |
| Tuition & Payments | `/school/wy1qNRECEgy8lg8pKqm0/tuition-dashboard?chrome=none` |
| Payments (Stripe Connect) | `/school/wy1qNRECEgy8lg8pKqm0/payments?chrome=none` |
| Donors | `/school/wy1qNRECEgy8lg8pKqm0/donors?chrome=none` |
| Marketing | `/school/wy1qNRECEgy8lg8pKqm0/marketing-dashboard?chrome=none` |

---

## Lunch + Menus

| Page | URL (embedded) |
|---|---|
| Lunch Roster (external + Menus sub-tab) | `/school/wy1qNRECEgy8lg8pKqm0/lunch-roster?chrome=none` |
| Lunch Roster → Menus sub-tab directly | `/school/wy1qNRECEgy8lg8pKqm0/lunch-roster?chrome=none&tab=menus` |
| Standalone Menus page | `/school/wy1qNRECEgy8lg8pKqm0/menus?chrome=none` |

External lunch app (unwrapped — keep as fallback):
`https://desert-garden-admin.vercel.app/lunch?token=…`

---

## Staff request system (teachers)

| Page | URL (embedded) |
|---|---|
| Submit a request (form picker) | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests?chrome=none` |
| My recent requests (per teacher) | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/mine?chrome=none` |
| **Calendar — my requests** | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/calendar?chrome=none` |
| Lexi's inbox (triage queue) | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/inbox?chrome=none` |
| **Calendar — all requests (Lexi)** | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/calendar?chrome=none&mode=all` |
| Labor Request form | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/staff-labor-request?chrome=none` |
| Incident / Accident Report | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/staff-incident-report?chrome=none` |
| In-House Supplies Request | `/school/wy1qNRECEgy8lg8pKqm0/staff-requests/staff-supply-request?chrome=none` |

When opening from a classroom hub, append `&from=classroom-N` so the
"Roster" tab links back to the right classroom.

---

## Parent-facing forms

The **public parent-facing URL** for any form lives on the parent portal
app: `https://growth-suite-parent-portal.vercel.app/forms-v2/<slug>`
(requires a parent login).

The **in-iframe Test mode** (for staff QA without a parent login):
`https://growth-suite-dashboards.vercel.app/school/wy1qNRECEgy8lg8pKqm0/forms/<form_id>/preview?chrome=none`

### Active parent forms (37)

| Form | Slug | Test preview link |
|---|---|---|
| Allergy / Special Diet | `allergy-special-diet` | `/school/wy1qNRECEgy8lg8pKqm0/forms/<id>/preview?chrome=none` |
| AZ Emergency, Info & Immunization Record | `az-state-emergency-immunization-card` | ↑ |
| AZ State Medication Consent (CCL 302) | `az-state-medication-consent` | ↑ |
| Authorization for Release / Pickup | `authorization-for-release` | ↑ |
| Authorization for Release of Information | `records-release-authorization` | ↑ |
| Authorization to Pick-Up | `pickup-authorization` | ↑ |
| Cafe Worker Permission | `cafe-worker-permission` | ↑ |
| Campout / Excursion (LE) | `le-campout-excursion` | ↑ |
| Carpool Authorization | `carpool-authorization` | ↑ |
| Concussion Acknowledgement | `concussion-acknowledgement` | ↑ |
| Flag Football Registration | `flag-football-registration` | ↑ |
| Golf Registration | `golf-registration` | ↑ |
| Pickleball Registration | `pickleball-registration` | ↑ |
| Enrollment Agreement 2026-27 | `dgm-enrollment-agreement-2026-27` | ↑ |
| Field Trip — High Adventure | `field-trip-high-adventure` | ↑ |
| Field Trip — Generic | `field-trip-generic` | ↑ |
| Childplay's Theater Permission | `fieldtrip-childplay-theater` | ↑ |
| Health Form / Medical Info | `health-form` | ↑ |
| Immunization Exemption | `immunization-exemption` | ↑ |
| Internet / Technology Use | `internet-technology-use` | ↑ |
| LE Staying Safe Permission | `le-staying-safe-permission` | ↑ |
| Mosquito Repellent Permission | `mosquito-repellent-permission` | ↑ |
| MYHS OTC Medication Consent | `myhs-otc-medication-consent` | ↑ |
| OTC Medication Authorization | `otc-medication-authorization` | ↑ |
| Parent / Student Handbook Ack | `handbook-acknowledgement` | ↑ |
| Photography / Media Release | `photography-media-release` | ↑ |
| Primary Staying Safe Permission | `primary-staying-safe-permission` | ↑ |
| Request to Administer Medication | `request-administering-medication` | ↑ |
| Spartan Registration | `spartan-registration` | ↑ |
| Sports Participation | `sports-participation` | ↑ |
| Summer Registration — Elementary 2026 | `summer-registration-elementary-2026` | ↑ |
| Summer Registration — Infant/Toddler/Primary 2026 | `summer-registration-itp-2026` | ↑ |
| Sunscreen Application | `sunscreen-authorization` | ↑ |
| Tuition Agreement | `tuition-agreement` | ↑ |
| Tuition Enrollment 2026-27 | `tuition-enrollment-2026-27` | ↑ |
| Volunteer Background Check | `volunteer-background-check` | ↑ |
| Class trip — preview (demo) | `payments-preview-class-trip` | ↑ |

To get the `<id>` for any form's preview link, visit the Portal Forms
dashboard above and click into the form — the URL contains it. Or query
`portal_form_definitions` directly.

---

## Operator (admin) URLs — for you, not embedded

These are the back-office pages you use as the operator. Plain
`growth-suite-dashboards.vercel.app` base, no `chrome=none`.

| Page | URL |
|---|---|
| Admin home | `/admin` |
| DGM school home | `/admin/cfa9030d-c8fe-49ae-a9e7-f1003844ec07` |
| Forms management | `/admin/cfa9030d-c8fe-49ae-a9e7-f1003844ec07/forms` |
| Payments / products | `/admin/cfa9030d-c8fe-49ae-a9e7-f1003844ec07/payments` |
| Uploads from parents | `/admin/cfa9030d-c8fe-49ae-a9e7-f1003844ec07/uploads` |
| Operator login | `/login` |

---

## External tools DGM uses

| Tool | URL |
|---|---|
| GHL CRM (DGM workspace) | `https://app.gohighlevel.com/v2/location/wy1qNRECEgy8lg8pKqm0` |
| External Lunch Roster (legacy) | `https://desert-garden-admin.vercel.app/lunch?token=…` |
| Stripe Dashboard (DGM Connect) | Resolved via Stripe Connect after onboarding |

---

## How to share these with Lexi / teachers

For Custom Menu Links inside GHL, point each menu item at the full
`https://growth-suite-dashboards.vercel.app{path}?chrome=none` URL.

For a quick teacher walkthrough, the entry point is usually the
**Classroom Hub** — every other relevant tab (Submit Request, My
Requests, Documents, Lunch Roster, Menus) hangs off the top tab bar.
