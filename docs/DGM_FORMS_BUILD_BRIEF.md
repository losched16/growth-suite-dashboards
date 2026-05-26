# Desert Garden Montessori — Parent Portal Forms Build Brief

**Client:** Desert Garden Montessori (DGM)
**Target platform:** MyGrowthSuite parent portal
**Companion data file:** `dgm_forms_inventory.json` (structured field-level spec for all forms)
**Prepared:** May 2026

---

## 1. What This Is

DGM currently runs intake, permission, registration, and consent forms across three systems: Google Forms, Smartsheets, and PDFs. This brief consolidates 22 of those forms into a single source of truth so they can be auto-created inside the MyGrowthSuite parent portal.

The companion JSON file (`dgm_forms_inventory.json`) is the machine-readable spec. This markdown file is the human-readable build guide, with implementation notes, template recommendations, gaps to resolve, and a suggested build order.

---

## 2. Status Summary

**22 forms total**

| Status | Count | Meaning |
|---|---|---|
| ✅ Complete | 17 | Full field list, types, options, required flags, helper text — ready to build |
| ⚠️ Partial | 2 | Description captured; field list needs DGM (closed forms at time of capture) |
| 🔒 Blocked | 3 | 401 auth errors; need DGM to unlock, screenshot, or paste content |

**Complete (17):**
1. Authorization to Pick-Up Form
2. Campout Participation and Excursion Form for LE
3. MYHS — Consent for OTC Medication Administration Form
4. Cafe Worker Permission Form
5. Fieldtrip: Childplay's Theater Performance Permission Form
6. Lower E Staying Safe Permission Form
7. Primary Staying Safe Permission Form
8. Mosquito Repellent Permission Form
9. Request For Administering Medication Form
10. DGM Flag Football Registration Form
11. DGM Golf Registration Form
12. DGM Pickle Ball Registration Form
13. Spartan Registration Form
14. Authorization For Release Of Information
15. Arizona State Emergency, Information and Immunization Record Card
16. Arizona State Medication Consent Form
17. (counted; see JSON)

Plus Summer ITP 2026 and Summer Elementary 2026 (counted as complete with caveat that 4 dropdown option lists need DGM).

**Partial (2):**
- Childcare Registration Form — form closed; description only
- Fall Enrichments — form closed; description only

**Blocked (3):**
- Field Study Excursion Form (student specific) — 401 auth
- Unknown Locked Form (URL: `135WW17twkpnyeoEljq6RDxcNcXkcha1rku4sj18ER6s`) — 401 auth, title unknown
- (Original Field Study Excursion sent twice with same ID)

---

## 3. Field Type Vocabulary

The JSON uses these field type strings. Map each one to the equivalent MyGrowthSuite control:

| JSON type | Description | Suggested portal control |
|---|---|---|
| `short_text` | Single-line text | Text input |
| `long_text` | Multi-line text | Textarea |
| `email` | Email address | Email input (with validation) |
| `phone` | Phone number | Tel input (with formatting) |
| `date` | Calendar date | Date picker (MM/DD/YYYY) |
| `radio` | Single choice, all options visible | Radio group |
| `dropdown` | Single choice from a list | Select dropdown |
| `checkboxes` | Multi-select | Checkbox group |
| `checkbox_grid` | Matrix of rows × columns | Grid widget OR repeating Yes/No per row if grid not native |
| `acknowledgment_checkbox` | "I have read and agree" type | Required checkbox with associated long-form text |
| `file_upload` | File attachment | File upload control |
| `repeatable_table` | Multi-row table (e.g., admin logs) | Dynamic add-row table — STAFF-ONLY contexts |

---

## 4. Template Recommendations (BUILD ONCE, CONFIGURE MANY)

Four families of forms share enough structure to be built as parameterized templates rather than separate forms. This will significantly reduce build time and maintenance burden.

### 4.1 Sport Registration Template
Covers: Flag Football, Golf, Pickleball, Spartan (and any future sport)

**Common fields:** Student Name, Student Classroom, Shirt Size, Parent Signature, Parent Email
**Variables to expose:** sport name, season label, fee amount(s), pricing tiers, gear inclusions, age range, eligible classrooms, shirt size options (some use S/M/L/XL, Spartan uses Youth/Adult split), payment method (FACTS default)

**Master form to base it on:** Spartan (most complete; captures dual parent contacts and tiered pricing)

### 4.2 Staying Safe Permission Template
Covers: Primary Staying Safe, Lower E Staying Safe

**Common fields:** Student First Name, Student Last Name, Classroom, Teacher, Permission (Yes/No), Parent Signature, Email, Date
**Variables to expose:** program level (Primary/LE/UE/MYHS), eligible classrooms, teacher list (tied to staff records — NOT email addresses as options like the source forms do), date window

### 4.3 Fieldtrip Permission Template
Covers: Childplay Theater Permission, LE Campout, Field Study Excursion (when unblocked), and future trips

**Common fields:** Student First Name, Student Last Name, Classroom, Permission (Yes/No), Transportation Permission (Yes/No, optional), Parent Signature, Email, Date
**Variables to expose:** trip name, who/audience, venue + address, date(s), time, transportation toggle (show/hide), medical authorization clause (show/hide), eligible classrooms

### 4.4 Summer Registration Template
Covers: Summer ITP, Summer Elementary

**Common fields:** Week selection (checkboxes), Daily Schedule, Lunch Selection, Lunch Restrictions, Allergies, Billing Acknowledgment, E-signature
**Variables to expose:** year, program level (Infant/Toddler/Primary/Elementary), rate structure (monthly vs weekly vs both), week date ranges, daily schedule options per program (Half Day only available to Toddler/Primary), holiday proration notes, payment policy

---

## 5. Cross-Cutting Implementation Notes

### 5.1 E-Signature Pattern
Nearly every form uses the same e-signature pattern: a long-form consent paragraph followed by a typed-name field and a date.

**Recommendation:** Build a reusable "E-Signature Block" component with:
- Configurable consent text
- Typed signature input (required)
- Email input (required on most forms)
- Date input (auto-fill to today, parent can edit)

Standard consent text used by DGM:
> "By typing my name below I agree to conduct business with Desert Garden Montessori by electronic means. I intend by typing my name below to 'sign' the preceding document and to be bound by its terms and conditions."

### 5.2 Classroom Picker — Master List
The most complete classroom list appears in the Request for Administering Medication form. Use this as the master:
- CR1, CR2, CR3, CR4, CR5, CR6, CR7, CR8 (Primary)
- LE CR11, LE CR12 (Lower Elementary)
- UE CR10, UE Tower (Upper Elementary)
- MS 7 & 8 (Middle School)
- HS 9, 10, 11 & 12 (High School)

Build this as a managed reference list. Individual forms can filter to a subset (e.g., athletics forms only show UE+).

### 5.3 Teacher Picker
Several forms (Staying Safe especially) use teacher email addresses as dropdown options. This is a source-system limitation.

**Recommendation:** Build a teacher picker tied to staff records. Display teacher name, store internal ID, send notifications to associated email.

### 5.4 Conditional Logic
Several forms have implicit conditional flows that should be made explicit in the portal:
- "Is your student allergic to medication?" Yes → show "Please list" text field
- "Does your student take medication regularly?" Yes → show "Please list" text field
- "Time and Frequency = Other" → show explanation textarea
- Summer ITP: Monthly vs Weekly options are mutually exclusive — recommend a top-level switch
- "Other:" checkbox in Release of Information → show explanation field

### 5.5 FACTS Payment Integration
All registration/seasonal forms charge through FACTS. The form itself doesn't process payment but acts as authorization.

**Recommendation:** Each fee-bearing form should include a clear "I authorize DGM to charge my FACTS account $XXX" acknowledgment, and submission should trigger a billing event (or notification to the Finance team) in MyGrowthSuite.

### 5.6 Staff-Only Sections
The AZ State Medication Consent Form includes a pre-administration checklist and a multi-row administration log. These are **NOT parent-facing** — they belong in a separate staff/admin module. Render only the consent and medication details sections on the parent portal.

### 5.7 Document Description Length
The Childcare Registration and Fall Enrichments forms have description text that runs 8+ paragraphs (policy, fees, cancellation rules, no-show fees, etc.). Burying this above form fields hurts completion rates.

**Recommendation:** Link to a separate "Policies" page for the long form, keep only essential context (dates, fees, deadlines) inline.

---

## 6. Data Quality Fixes to Apply During Build

Apply these corrections rather than carrying the source typos forward.

| Form | Source | Correction |
|---|---|---|
| MYHS OTC Medication | "Anti Naseau" | "Anti Nausea" |
| MYHS OTC Medication | "Hydrocortison Cream" | "Hydrocortisone Cream" |
| DGM Golf Registration | Classroom option "High" | "High School" |
| Summer ITP 2026 | "preceeding" (multiple) | "preceding" |
| Summer Elementary 2026 | "preceeding" (multiple) | "preceding" |
| Summer Elementary 2026 | "ABSENSES" | "ABSENCES" |
| Cafe Worker Permission | "Desert Garden Cafe" | Confirm with DGM — brand assets call it "The Wellness Cafe" |

**Also flag for DGM, do not auto-fix:**
- OTC Medication: "Is your student allergic to medication?" is free-text but should be Yes/No with conditional follow-up
- Authorization for Release of Information: source form does not mark any fields required — student name, signature, date should all be required
- Pickleball form: no parent email beyond signature; Spartan form: no parent signature despite collecting payment authorization. Confirm whether these are oversights.

---

## 7. Outstanding Items Needing DGM

These need to be resolved before or during build:

**Field-level gaps (need actual options):**
- Summer ITP 2026 — Summer Lunch Selection, Lunch Restrictions, Daily Schedule (dropdown options not in PDF export)
- Summer Elementary 2026 — Same four fields

**Blocked/closed forms (need access):**
- Childcare Registration — reopen, screenshot, or send response sheet headers
- Fall Enrichments — same
- Field Study Excursion — change sharing to "anyone with link" or send screenshots
- Unknown 401 form (`135WW17twkpnyeoEljq6RDxcNcXkcha1rku4sj18ER6s`) — title and content unknown

**Clarifications:**
- "Parent Home" on the Pickup Authorization form — confirmed home phone?
- Cafe Worker form — "Desert Garden Cafe" or "Wellness Cafe"?
- Are there matching versions of MYHS OTC Medication for younger grade bands?
- Are there matching campout/trip permission forms for UE, MS, HS?

---

## 8. Suggested Build Order

Build templates and shared components first, then individual forms. Save state-mandated forms for last because they have the strictest compliance requirements and the most staff-only/parent-only separation work.

**Phase 1 — Foundations**
1. E-Signature Block component
2. Classroom picker (master list)
3. Teacher picker (tied to staff records)
4. FACTS payment authorization flow

**Phase 2 — Templates**
5. Sport Registration template (build on Spartan as master, then configure Flag Football / Golf / Pickleball)
6. Staying Safe Permission template (configure Primary + LE)
7. Fieldtrip Permission template (configure Childplay Theater + LE Campout)
8. Summer Registration template (pending DGM option lists)

**Phase 3 — One-off Forms**
9. Authorization to Pick-Up Form
10. Cafe Worker Permission Form
11. Mosquito Repellent Permission Form
12. Request for Administering Medication Form
13. MYHS OTC Medication Administration Form (apply typo fixes; restructure allergy question)
14. Authorization for Release of Information
15. (Childcare Registration — once fields received)
16. (Fall Enrichments — once fields received)
17. (Field Study Excursion — once unblocked)

**Phase 4 — State Compliance Forms**
18. AZ State Emergency, Information and Immunization Record Card (with file upload for immunization record; parent-facing only — strip staff tracking fields)
19. AZ State Medication Consent Form (parent-facing only — staff checklist and admin log live in a separate staff module)

---

## 9. How to Use the Companion JSON

`dgm_forms_inventory.json` is structured as:

```
{
  "client": "...",
  "target_platform": "...",
  "forms": [
    {
      "form_id": "snake_case_id",
      "title": "Human Title",
      "source": "Google Forms | PDF upload | Smartsheet",
      "source_url": "...",
      "status": "PARTIAL | BLOCKED" (only on incomplete forms),
      "description": "Form-level description text",
      "category": "Athletics Registration (with fee) | etc.",
      "fee": { ...structured fee info if applicable... },
      "form_notes": "Build-time notes, template suggestions, flagged issues",
      "sections": [
        {
          "section_title": "Section name or null",
          "section_helper_text": "Helper text below the section title",
          "fields": [
            {
              "label": "Field label as shown to parent",
              "type": "short_text | dropdown | etc.",
              "required": true | false,
              "options": ["..."] (for dropdowns/radios/checkboxes),
              "notes": "Field-specific build notes"
            }
          ]
        }
      ]
    }
  ]
}
```

Iterate `forms[]`, skip any with `status` of `PARTIAL` or `BLOCKED`, build each one. Honor `form_notes` and per-field `notes` — they contain important context the field-only spec can't carry.

---

*End of brief.*
