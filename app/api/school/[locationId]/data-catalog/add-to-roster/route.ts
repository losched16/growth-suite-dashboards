// POST /api/school/{locationId}/data-catalog/add-to-roster
// form: field_key, kind ('column' | 'filter'), remove ('1' to remove)
//
// Makes a discovered field USABLE: promotes it into the school's filter catalog
// (so the roster renders it with a proper header and it also shows up in
// Customize roster) and adds it to the Student Roster as a column or filter.
// The roster already resolves any `cf:<key>` value from ghl_contact_field_values
// / metadata, so no per-field wiring is needed — this just registers + selects
// it. Idempotent + additive; removal only pulls it from the roster config.
// Operator OR matching school session.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/operator';
import { loadSchoolByLocationId } from '@/lib/dashboards/loader';
import { query } from '@/lib/db';

type Params = Promise<{ locationId: string }>;

// Match the attribute sync's GHL-type → roster-type mapping (ghl-attributes.ts).
function normalizeType(dataType: string | null, hasOptions: boolean): string {
  const dt = (dataType || '').toUpperCase();
  if (hasOptions || dt.includes('OPTION') || dt.includes('CHECKBOX') || dt.includes('RADIO')) return 'select';
  if (dt.includes('NUMER') || dt.includes('MONET')) return 'number';
  if (dt.includes('DATE')) return 'date';
  return 'text';
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { locationId } = await params;
  const school = await loadSchoolByLocationId(locationId);
  if (!school) return NextResponse.json({ error: 'unknown_school' }, { status: 404 });

  const ck = await cookies();
  const isOperator = verifySessionToken(ck.get(SESSION_COOKIE)?.value);
  const schoolSession = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!(isOperator || (schoolSession && schoolSession.school_id === school.id))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = `/school/${locationId}/data-catalog`;
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  const form = await request.formData();
  const fieldKey = String(form.get('field_key') ?? '').trim();
  const kind = String(form.get('kind') ?? 'column') === 'filter' ? 'filter' : 'column';
  const remove = String(form.get('remove') ?? '') === '1';
  if (!fieldKey) return back({ err: 'No field selected.' });

  try {
    const { rows: fRows } = await query<{ label: string | null; data_type: string | null; ghl_field_id: string | null; options: string[] }>(
      `SELECT label, data_type, ghl_field_id, options FROM school_field_catalog
        WHERE school_id = $1 AND field_key = $2`,
      [school.id, fieldKey]);
    const field = fRows[0];
    if (!field) return back({ err: 'That field is no longer in your catalog.' });

    const attrKey = `cf:${fieldKey}`;
    const label = field.label || fieldKey;

    if (!remove) {
      // Promote into the usable filter catalog (so header label + roster-settings work).
      const rosterType = normalizeType(field.data_type, (field.options?.length ?? 0) > 0);
      await query(
        `INSERT INTO school_filter_catalog (school_id, attr_key, attr_type, label, ghl_field_id, data_type, sample_values, value_count)
         VALUES ($1, $2, 'custom_field', $3, $4, $5, $6::jsonb, 0)
         ON CONFLICT (school_id, attr_key) DO UPDATE SET
           label = EXCLUDED.label, data_type = EXCLUDED.data_type, ghl_field_id = EXCLUDED.ghl_field_id`,
        [school.id, attrKey, label, field.ghl_field_id, rosterType, JSON.stringify(field.options ?? [])]);
    }

    // Load + update the roster widget config.
    const { rows: dashRows } = await query<{ layout: Array<{ widget_id: string; config: Record<string, unknown> }> }>(
      `SELECT layout FROM school_dashboards WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
      [school.id]);
    if (dashRows.length === 0) {
      return back({ err: 'You don’t have a Student Roster dashboard yet — add it from “Add dashboard,” then try again.' });
    }
    const layout = dashRows[0].layout;
    let touched = false;
    for (const w of layout) {
      if (w.widget_id !== 'student_roster_rich') continue;
      const listKey = kind === 'filter' ? 'extra_filters' : 'extra_columns';
      const cur = Array.isArray(w.config[listKey]) ? (w.config[listKey] as string[]) : [];
      const set = new Set(cur);
      if (remove) set.delete(attrKey); else set.add(attrKey);
      w.config = { ...w.config, [listKey]: [...set] };
      touched = true;
    }
    if (!touched) return back({ err: 'Roster widget not found on your Student Roster dashboard.' });

    await query(
      `UPDATE school_dashboards SET layout = $2::jsonb, updated_at = now()
        WHERE school_id = $1 AND dashboard_slug = 'student-roster'`,
      [school.id, JSON.stringify(layout)]);
    await query(
      `UPDATE school_field_catalog SET surfaced = $3, updated_at = now() WHERE school_id = $1 AND field_key = $2`,
      [school.id, fieldKey, !remove]);

    return back({
      msg: remove
        ? `Removed “${label}” from the roster.`
        : `Added “${label}” to the Student Roster as a ${kind}. Open the roster to see it.`,
    });
  } catch (err) {
    return back({ err: `Failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}
