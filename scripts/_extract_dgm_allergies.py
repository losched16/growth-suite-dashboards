"""Parse the DGM 'Allergies & Special Needs 2025-26' Excel into a flat
JSON list keyed by classroom + student name.

Source layout (one long sheet):
  - Rows whose first column is a "Classroom N" / "Tower" / "MYHS" header
    are SECTION DIVIDERS — they don't carry student data, but mark the
    classroom for every subsequent row until the next divider.
  - Other rows: column A = student name, B = food allergy / notes,
    C = other special instructions, D-E = blank.

Output (stdout when run, also writes scripts/data/dgm_allergies_2025_26.json):
  [
    {
      "classroom": "Classroom 4",
      "name":      "Jamie Arnote",
      "food_allergy":          "" | "Eggs, milk and Almonds",
      "special_instructions":  "" | "Torticollis - he favors..."
    },
    ...
  ]

Re-run safely after the source workbook is updated — the importer is
idempotent.

Usage:
    python scripts/_extract_dgm_allergies.py \
        "C:/Users/thelo/Downloads/Allergies & Special Needs 2025-26.xlsx"
"""

import json
import re
import sys
from pathlib import Path

import pandas as pd

CLASSROOM_HEADER_RE = re.compile(
    r"^(Classroom\s+\d+|Tower|MYHS|UE\s*CR\d+|LE\s*CR\d+|MS|HS|Primary|Lower Elementary|Upper Elementary)$",
    re.IGNORECASE,
)


def clean(s) -> str:
    """Strip + normalize whitespace + replace stray non-breaking spaces."""
    if pd.isna(s):
        return ""
    return re.sub(r"\s+", " ", str(s).replace("\xa0", " ").replace("�", "'")).strip()


def is_classroom_header(name: str, food: str, special: str) -> bool:
    # Header rows look like: ["Classroom 4", NaN/"Food Allergy/ Notes ", NaN/"Other Special Instructions"]
    # OR: ["Tower", "Food Allergy/ Notes ", "Other Special Instructions"]
    if not name:
        return False
    if CLASSROOM_HEADER_RE.match(name):
        return True
    # A header row always has B = "Food Allergy/ Notes" — use as a sanity check
    if food.lower().startswith("food allergy"):
        return True
    return False


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python _extract_dgm_allergies.py <xlsx_path>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 2

    df = pd.read_excel(path, sheet_name=0)
    out = []
    current_classroom = None

    for _, row in df.iterrows():
        name = clean(row.iloc[0])
        food = clean(row.iloc[1])
        special = clean(row.iloc[2])

        if not name and not food and not special:
            continue  # blank row

        if is_classroom_header(name, food, special):
            current_classroom = name
            continue

        # Student row.
        if not current_classroom:
            # Some rows at the top of the sheet had no preceding classroom header
            # — they belong to Classroom 4 per the first sheet section.
            current_classroom = "Classroom 4"

        if not name:
            # Special case: row 23 had blank name (Henry's mosquito notes) —
            # likely the previous student's continuation. Skip & log.
            print(f"  warn: row missing student name (food={food[:40]!r}, special={special[:40]!r}) — skipping", file=sys.stderr)
            continue

        out.append({
            "classroom": current_classroom,
            "name": name,
            "food_allergy": food,
            "special_instructions": special,
        })

    # Write to the repo's data dir so it's versioned + the Node seeder
    # can read it without re-running this preprocessor.
    target = Path(__file__).resolve().parent / "data" / "dgm_allergies_2025_26.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    # ascii-only prints — Windows default cp1252 console chokes on arrows.
    print(f"wrote {len(out)} student rows -> {target}")
    print(f"  classrooms: {sorted(set(r['classroom'] for r in out))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
