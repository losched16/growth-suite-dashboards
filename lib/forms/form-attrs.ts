// Portal-form answers as self-serve roster attributes.
//
// The roster's column/filter picker only knew GHL contact fields, tags and
// pipeline data — anything a parent typed into a portal form (emergency
// contacts, per-student health answers, permissions) was invisible to it,
// and some GHL fields (TEXTBOX_LIST phones) never reach the attribute
// snapshot at all. These attrs expose every question on every active form:
//
//   form:<formId>:<fieldKey>               one question, latest answer
//   form:<formId>:__emergency_contacts     every emergency contact on the
//                                          form, combined into one cell
//
// Values come from lib/forms/student-report (latest submission per student,
// or per family for family forms; amendments and earlier imports included).
// They're synthesized at read time rather than stored in
// school_filter_catalog, which the GHL attribute sync rebuilds from scratch.

import { query } from '@/lib/db';
import { buildStudentReport } from '@/lib/forms/student-report';

export const FORM_ATTR_PREFIX = 'form:';
const EC_KEY = '__emergency_contacts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_ONLY = new Set(['header', 'paragraph', 'section', 'signature_stamp', 'divider', 'image']);
// ec1_name / emergency_contact_2_phone / … → slot + part
const EC_FIELD = /^(?:ec|emergency_contact_?)(\d+)_(name|phone|relationship)/i;

export interface FormAttr {
  attr_key: string;
  attr_type: 'form_answer';
  label: string;
  data_type: string;
  value_count: number;
  sample_values: string[];
}

type Block = { key?: string; label?: string; type?: string; options?: Array<{ value?: unknown; label?: unknown } | string> };

export function parseFormAttr(attr: string): { formId: string; key: string } | null {
  if (!attr.startsWith(FORM_ATTR_PREFIX)) return null;
  const rest = attr.slice(FORM_ATTR_PREFIX.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  const formId = rest.slice(0, i);
  const key = rest.slice(i + 1);
  return UUID.test(formId) && key ? { formId, key } : null;
}

export async function listFormAttrs(schoolId: string): Promise<FormAttr[]> {
  const { rows } = await query<{ id: string; display_name: string; field_schema: Block[] | null; answered: number }>(
    `SELECT d.id, d.display_name, d.field_schema,
            (SELECT COUNT(*)::int FROM portal_form_submissions s
              WHERE s.form_definition_id = d.id AND s.voided_at IS NULL
                AND COALESCE(s.is_test, false) = false
                AND s.status IN ('submitted', 'paid', 'pending_payment', 'legacy_imported')) AS answered
       FROM portal_form_definitions d
      WHERE d.school_id = $1 AND d.is_active = true AND d.audience IS DISTINCT FROM 'staff'
      ORDER BY d.display_name`,
    [schoolId],
  );
  const out: FormAttr[] = [];
  for (const f of rows) {
    const blocks = (Array.isArray(f.field_schema) ? f.field_schema : [])
      .filter((b) => b && typeof b.key === 'string' && b.key && !DISPLAY_ONLY.has(String(b.type ?? '')))
      .filter((b) => !/signature/i.test(String(b.key)) && !/^signature/.test(String(b.type ?? '')));
    if (blocks.some((b) => EC_FIELD.test(String(b.key)))) {
      out.push({
        attr_key: `${FORM_ATTR_PREFIX}${f.id}:${EC_KEY}`, attr_type: 'form_answer',
        label: `${f.display_name}: Emergency contacts (all, in one column)`,
        data_type: 'text', value_count: f.answered, sample_values: [],
      });
    }
    for (const b of blocks) {
      const opts = (Array.isArray(b.options) ? b.options : [])
        .map((o) => (typeof o === 'string' ? o : String(o?.label ?? o?.value ?? '')))
        .filter(Boolean);
      out.push({
        attr_key: `${FORM_ATTR_PREFIX}${f.id}:${b.key}`, attr_type: 'form_answer',
        label: `${f.display_name}: ${String(b.label ?? b.key).replace(/\s+/g, ' ').trim()}`,
        // multi-choice answers are '; '-joined, so contains-matching is the safe filter
        data_type: opts.length && !/checkbox|multi/i.test(String(b.type ?? '')) ? 'select' : 'text',
        value_count: f.answered,
        sample_values: opts.slice(0, 20),
      });
    }
  }
  return out;
}

// Old-form phone leftovers: "Cell (Primary)-3307499567, Home-, Work-".
function tidyPhone(v: string): string {
  const parts = v.split(/[,;]/).map((p) => p.trim()).filter((p) => p && !/^[A-Za-z ()]+-\s*$/.test(p));
  return parts.map((p) => p.replace(/^Cell \(Primary\)\s*-?\s*/i, '')).join(', ');
}

// student id → { attr_key → display value } for the requested form attrs.
export async function resolveFormAttrValues(
  schoolId: string,
  attrKeys: string[],
): Promise<Map<string, Record<string, string>>> {
  const wanted = attrKeys.map((a) => ({ attr: a, p: parseFormAttr(a) })).filter((x) => x.p) as Array<{ attr: string; p: { formId: string; key: string } }>;
  const out = new Map<string, Record<string, string>>();
  if (wanted.length === 0) return out;
  const formIds = [...new Set(wanted.map((w) => w.p.formId))];
  const report = await buildStudentReport({ schoolId, formIds, scope: 'all' });

  // per form: emergency-contact slot → { name, phone, relationship } column ids
  const ecCols = new Map<string, Map<number, Record<string, string>>>();
  for (const c of report.columns) {
    const m = c.key ? EC_FIELD.exec(c.key) : null;
    if (!m) continue;
    const slots = ecCols.get(c.formId) ?? new Map<number, Record<string, string>>();
    const slot = slots.get(Number(m[1])) ?? {};
    slot[m[2].toLowerCase()] = c.id;
    slots.set(Number(m[1]), slot);
    ecCols.set(c.formId, slots);
  }

  for (const row of report.rows) {
    const vals: Record<string, string> = {};
    for (const { attr, p } of wanted) {
      let v = '';
      if (p.key === EC_KEY) {
        const slots = [...(ecCols.get(p.formId) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]);
        v = slots
          .map(([, ids]) => {
            const name = ids.name ? row.values[ids.name] ?? '' : '';
            if (!name) return '';
            const rel = ids.relationship ? row.values[ids.relationship] ?? '' : '';
            const phone = ids.phone ? tidyPhone(row.values[ids.phone] ?? '') : '';
            return `${name}${rel ? ` (${rel})` : ''}${phone ? ` ${phone}` : ''}`;
          })
          .filter(Boolean)
          // one contact per line — roster cells render with pre-wrap
          .join(String.fromCharCode(10));
      } else {
        v = row.values[`${p.formId}|${p.key}`] ?? '';
        if (EC_FIELD.test(p.key) && /phone/i.test(p.key)) v = tidyPhone(v);
      }
      if (v) vals[attr] = v;
    }
    if (Object.keys(vals).length) out.set(row.studentId, vals);
  }
  return out;
}
