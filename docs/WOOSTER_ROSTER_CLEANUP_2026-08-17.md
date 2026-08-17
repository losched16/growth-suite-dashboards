# Wooster roster cleanup — 2026-08-17

Source: "form status all forms missing 2026-08-17 - GW → MSW.csv" (columns H–K = correct data).
All changes made in GHL (source of truth), then synced. Nothing edited directly in the dashboard DB.

## Done

**Students added to existing contacts (10)**
| Student | Contact | Slot | Program |
|---|---|---|---|
| Stacey Adams | Martez Phillips | 2 | Middle School |
| Bruce Eriksen | Annie Eriksen | 2 | CH preschool |
| Victoria Fletcher | Vanessa Fletcher | 2 (slot said "Vanessa" — fixed) | High School |
| Ivy Fox | Tiara Schaffter | 2 | Lower El |
| Remi Overmyer | Sasha Overmyer | 2 | CH preschool |
| Jensen Wonnell | Hannah Crocker | 2 | 5-day toddler 7–6 |
| Janeane Pummell | Alissa Pummell | 1 | Middle School |
| Knox Reed | Chris Reed | 1 | (see question 6) |
| Benson Nethers | Brandon Nethers | 1 | Lower El |
| Azeila Spitler | contact "Azielia Spitler" | 1 | 5-day toddler 8–4 |

**Renamed in place (forms stay attached — slot unchanged)**
- Morgan slot 3: Katherine → **Charles Morgan**
- Carmony slot 2: "Samuel Heath Carmony" → **Heath Carmony**
- Jiang slot 1: "Zong / Han Jiang" → **Zong Han / Jiang**
- Turchyn slot 1: "Evolet, Penny" → **Evolet** (slot 2 stays Penny)
- Draper slot 3: duplicate "Celia" → **Claira** (Upper El); slot 1 stays Celia
- Koval slot 1: trimmed "Izzabella  Griffith" double space

**Enrolled status + tag**: every student on the sheet that matched a GHL slot (224) is now `enrolled` and the contact carries `enrolled - 26/27`. Fixed 12 that were missing (Phillips, Fletcher, Schaffter, Jiang, Sigler, Allison, Pritchett, Dunlap ×2, Prentice, Ritter, Haider, S. Miller, Carafelli, Zsoldos, Deily, Murray, McClintock, G. Miller, Neville, Dickens, C. Smith).

**Program**: created per-slot program fields (Student 2/3/4 "Select the program this child will attend", same options as slot 1). Set program from column K on 98 students — 79 were blank, 19 corrected (mostly last year's program still on the contact: preschool → Kindergarten, Upper El → Middle School, "Grades 9 or 10" → "Grades 9-12").

**Result after sync**: 286 students (was 275), 259 with enrollment rows (was 233), 247 enrolled / 11 withdrawn.
New students appear on the roster / Enrollment Hub / Portal Forms Tracker / parent portal checklist now, and in the 9 AM reminder cycle.

## Questions for Wooster (nothing below was changed)

1. **Draper** — the third child is Claira (per this sheet); an earlier list said Adam. Confirm Claira.
2. **Griffith / Koval** — sheet lists her twice: "Isabella Griffith / MSW" and "Isabella Koval / Angela Koval". GHL has one child, "Izzabella Griffith", enrolled, forms complete. Same child? Correct spelling and last name?
3. **Fletcher** — Diolun (GHL, one card) vs Diloun (sheet, other card). Which?
4. **Woodas** — Lilith Woodas (GHL; dad's contact is Benjamin Woodas) vs Lillith Woodith (sheet). Which?
5. **Stout** — GHL has Emma + **Jett** (4/5, CH); sheet has Emma + **Brogan** (5-day toddler). Is Jett = Brogan? Not renamed.
6. **Knox Reed** — sheet program "4 day toddler 8-4" isn't one of the 13 programs. Which toddler program?
7. **Delilah Frederick-Norr** — sheet program "Two day toddler program 11:30am-5pm" isn't an option either. Program left as-is.
8. **Spitler** — contact is named "Azielia Spitler" (the child); sheet says parent is Teri Malcuit and spells the child Azeila. Rename contact to Teri Malcuit? Which spelling? (Teri Malcuit is also listed as parent of Isaac Sigler, whose contact is Steven Sigler.)
9. **Allison Allison** — Sapphire's parent contact literally has first name Allison, last name Allison. Real parent name?
10. **Crystal — your own contact** has Raice in slot 1 AND slot 2 (both with form dates, plus slot-3 form dates with no student). Which slot should stay? Program says Lower El; sheet says Upper El.

## New families — need a confirmed email before I create the contact

| Student | Parent | Candidate email |
|---|---|---|
| Nova Barbera | Jessika Rice | destinationtreasuretrove87@gmail.com |
| James Blair | Kelsey Brubaker | craydenk@gmail.com |
| Enzo Kratko | Yen Huynh | brian.kratko@icloud.com |
| Beauden Powers | Ciara Powers | ciarapowers1031@gmail.com |
| Sophia Snodgrass | "Mom" | unknown (the sheet's email belongs to Abigail Shepp) |

⚠️ Column G (email) in the sheet is misaligned from row ~66 down (one family behind, four rows behind by the end) — do not use it as-is.

## Duplicates for the office to merge/withdraw in GHL

- "Camille Mullet" contact (moolay@gmail.com) duplicates the real family under **Amanda Good** — merge or delete.
- Second, empty "Martez Phillips" contact (no email); second, empty "Alissa Pummell" contact (no email).
- **Freya Prentice** is listed on both Andrew Prentice's and Quinta Prentice's contacts → shows twice on the roster. Either remove her from one contact, or turn on co-parent merge for the school.
- **Tristan Dixon** (Abigail Shepp) is enrolled in GHL but not on the sheet — withdrawn?
- Chris Reed / Brandon Nethers linked to Knox / Benson on surname + "forms completed" tag — shout if wrong.
