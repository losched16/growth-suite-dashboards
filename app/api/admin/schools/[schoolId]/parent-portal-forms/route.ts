// CRUD for school_forms. Single endpoint that handles add / edit / delete
// based on the `op` form field, so the operator UI is a single page with
// a few inline forms.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';

type Params = Promise<{ schoolId: string }>;

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { schoolId } = await params;
  try {
    const form = await request.formData();
    const op = String(form.get('op') ?? '');

    if (op === 'delete') {
      const formId = String(form.get('form_id') ?? '');
      if (!formId) throw new Error('form_id required');
      await query(`DELETE FROM school_forms WHERE id = $1 AND school_id = $2`, [formId, schoolId]);
      return back(request, schoolId, { msg: 'Form removed.' });
    }

    const display_name = String(form.get('display_name') ?? '').trim();
    const description = strOrNull(form.get('description'));
    const completion_field_key = String(form.get('completion_field_key') ?? '').trim();
    const fill_out_url = strOrNull(form.get('fill_out_url'));
    const per_student = form.get('per_student') !== null;
    const position = Number(form.get('position') ?? 0);
    const is_active = form.get('is_active') !== null;

    if (!display_name) throw new Error('display_name required');
    if (!completion_field_key) throw new Error('completion_field_key required');

    if (op === 'add') {
      await query(
        `INSERT INTO school_forms
           (school_id, display_name, description, completion_field_key,
            fill_out_url, per_student, position, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [schoolId, display_name, description, completion_field_key, fill_out_url, per_student, position, is_active],
      );
      return back(request, schoolId, { msg: `Added "${display_name}".` });
    }

    if (op === 'update') {
      const formId = String(form.get('form_id') ?? '');
      if (!formId) throw new Error('form_id required');
      await query(
        `UPDATE school_forms SET
           display_name = $1, description = $2, completion_field_key = $3,
           fill_out_url = $4, per_student = $5, position = $6, is_active = $7,
           updated_at = now()
         WHERE id = $8 AND school_id = $9`,
        [display_name, description, completion_field_key, fill_out_url, per_student, position, is_active, formId, schoolId],
      );
      return back(request, schoolId, { msg: `Updated "${display_name}".` });
    }

    throw new Error(`unknown op: ${op}`);
  } catch (err) {
    return back(request, schoolId, {
      err: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function back(request: NextRequest, schoolId: string, q: { msg?: string; err?: string }) {
  const url = request.nextUrl.clone();
  url.pathname = `/admin/${schoolId}`;
  url.search = '';
  if (q.msg) url.searchParams.set('msg', q.msg);
  if (q.err) url.searchParams.set('err', q.err);
  url.hash = 'parent-portal';
  return NextResponse.redirect(url, 303);
}
