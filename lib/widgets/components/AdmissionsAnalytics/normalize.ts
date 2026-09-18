// Value normalisers for free-text admissions fields. Families type these
// by hand ("4", "4th", "04", "fourth"), so grouping raw values would split
// one answer into many rows.

// Boston ZIP → neighborhood. ZIPs outside Boston fall back to the city.
const BOSTON_ZIP_NEIGHBORHOOD: Record<string, string> = {
  '02108': 'Beacon Hill', '02109': 'Downtown', '02110': 'Downtown', '02111': 'Chinatown',
  '02113': 'North End', '02114': 'West End', '02115': 'Fenway', '02116': 'Back Bay',
  '02118': 'South End', '02119': 'Roxbury', '02120': 'Mission Hill', '02121': 'Dorchester',
  '02122': 'Dorchester', '02124': 'Dorchester', '02125': 'Dorchester', '02126': 'Mattapan',
  '02127': 'South Boston', '02128': 'East Boston', '02129': 'Charlestown', '02130': 'Jamaica Plain',
  '02131': 'Roslindale', '02132': 'West Roxbury', '02134': 'Allston', '02135': 'Brighton',
  '02136': 'Hyde Park', '02163': 'Allston', '02199': 'Back Bay', '02210': 'Seaport',
  '02215': 'Fenway',
};

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/(^|[\s\-/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export function normZip(raw: string | undefined): string | null {
  const m = (raw ?? '').match(/\b(\d{5})(?:-\d{4})?\b/);
  if (m) return m[1];
  // MA ZIPs typed without the leading zero ("2124").
  const four = (raw ?? '').trim().match(/^(\d{4})$/);
  return four ? '0' + four[1] : null;
}

export function neighborhood(zip: string | null, city: string | undefined): string | null {
  if (zip && BOSTON_ZIP_NEIGHBORHOOD[zip]) return BOSTON_ZIP_NEIGHBORHOOD[zip];
  const c = (city ?? '').trim();
  if (!c) return null;
  const t = titleCase(c);
  // A Boston neighborhood typed as the city is already the answer.
  return t === 'Boston' && zip ? `Boston (${zip})` : t;
}

const WORD_NUM: Record<string, number> = {
  kindergarten: 0, k: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9,
};

export function ordinal(n: number): string {
  if (n === 0) return 'Kindergarten';
  const s = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${s} grade`;
}

export function normGrade(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/^\d+\s*-\s*\d+$/.test(v)) return v.replace(/\s+/g, '') + ' (unclear)';
  const num = v.match(/\d+/);
  if (num) return ordinal(parseInt(num[0], 10));
  for (const [w, n] of Object.entries(WORD_NUM)) if (v.split(/\s+/).includes(w)) return ordinal(n);
  return titleCase(v);
}

export function gradeSortKey(label: string): number {
  if (label === 'Kindergarten') return 0;
  const m = label.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 99;
}

const DEFAULT_LANGUAGE_ALIASES: Record<string, string> = {
  'haitian kreyol': 'Haitian Creole', 'kreyol': 'Haitian Creole', 'haitian creole': 'Haitian Creole',
  'haitian': 'Haitian Creole', 'cape verdean criolo': 'Cape Verdean Creole', 'cape verdean creole': 'Cape Verdean Creole',
  'cape verdean': 'Cape Verdean Creole', 'kriolu': 'Cape Verdean Creole', 'criolo': 'Cape Verdean Creole',
  'spanish': 'Spanish', 'espanol': 'Spanish', 'español': 'Spanish', 'ghana twi': 'Twi', 'twi': 'Twi',
};

export function splitLanguages(raw: string | undefined, aliases: Record<string, string> = {}): string[] {
  const all = { ...DEFAULT_LANGUAGE_ALIASES, ...Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v])) };
  const out = new Set<string>();
  for (const part of (raw ?? '').split(/[,;/&+]|\band\b/i)) {
    const k = part.toLowerCase().replace(/[.()]/g, '').replace(/\s+/g, ' ').trim();
    // Skip blanks and mis-typed entries (an email pasted in the wrong box).
    if (!k || k === 'n/a' || k === 'na' || k.includes('@') || /\d/.test(k)) continue;
    out.add(all[k] ?? titleCase(k));
  }
  return [...out];
}

// Group school names that differ only in case / punctuation / spacing;
// explicit aliases (lower-cased key → display name) merge the rest.
export function schoolKey(raw: string): string {
  return raw.toLowerCase().replace(/[.,'’"]/g, '').replace(/\s+/g, ' ').trim();
}

export function incomeSortKey(label: string): number {
  const m = label.replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
}

export function normName(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, ' ').trim();
}
