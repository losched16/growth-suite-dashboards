// Form-handler for the operator's field-schema editor at /admin/{schoolId}.
// Accepts the JSON-textareas payload, validates lightly, upserts the row.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { upsertSchoolFieldSchema } from '@/lib/sync/schema-loader';

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  try {
    const form = await request.formData();
    const familyJson = String(form.get('family_fields') ?? '{}');
    const parent2Json = String(form.get('parent2_fields') ?? '{}');
    const studentJson = String(form.get('student_fields') ?? '{}');
    const maxSlots = Number(form.get('max_student_slots') ?? 4);
    const academicYear = String(form.get('default_academic_year') ?? '2026-27').trim();
    const notes = String(form.get('notes') ?? '').trim() || null;
    // Optional checkbox: "Keep parent-only families (no student data yet)"
    const allowParentOnly = form.get('allow_parent_only_families') === 'on'
      || form.get('allow_parent_only_families') === 'true'
      || form.get('allow_parent_only_families') === '1';

    const family_fields = parseStringMap(familyJson, 'family_fields');
    const parent2_fields = parseStringMap(parent2Json, 'parent2_fields');
    const student_fields = parseStringMap(studentJson, 'student_fields');

    if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 10) {
      return redirect(request, schoolId, { err: 'max_student_slots must be an integer between 1 and 10' });
    }
    if (!academicYear) {
      return redirect(request, schoolId, { err: 'default_academic_year is required' });
    }

    await upsertSchoolFieldSchema(schoolId, {
      family_fields,
      parent2_fields,
      student_fields,
      max_student_slots: maxSlots,
      default_academic_year: academicYear,
      notes,
      allow_parent_only_families: allowParentOnly,
    });
    return redirect(request, schoolId, { msg: 'Field schema saved.' });
  } catch (err) {
    return redirect(request, schoolId, {
      err: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function parseStringMap(raw: string, label: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new Error(`${label}.${k} must be a string (got ${typeof v})`);
    }
    out[k] = v;
  }
  return out;
}

function redirect(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  url.hash = 'field-schema';
  return NextResponse.redirect(url, 303);
}
