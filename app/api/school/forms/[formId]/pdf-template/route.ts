// POST /api/school/forms/{formId}/pdf-template
//
// Official-PDF form templates. The school uploads an unmodifiable PDF
// (state emergency card, diocese form). We read its AcroForm field
// inventory with pdf-lib, store the template, and — when the form has no
// PDF-bound fields yet — auto-generate field_schema blocks, one per PDF
// field, each carrying `pdf_field` (the PDF's own field name). The office
// then relabels/reorders in the normal editors; parents fill a normal
// portal form; the portal's submit pipeline writes the answers onto the
// actual PDF.
//
// Obvious identity fields get prefill bindings so the state card arrives
// pre-filled with the student/parent data already on the contact.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFSignature } from 'pdf-lib';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;

type Params = Promise<{ formId: string }>;

interface InventoryEntry {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'signature' | 'other';
  options?: string[];
}

// PDF field name → clean human label ("Childs Name" → "Child's Name" is
// out of reach, but at least trim the truncated-question junk).
function labelFromName(name: string): string {
  const cleaned = name.replace(/_\d+$/, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || /^undefined/.test(cleaned)) return name;
  return cleaned.length > 90 ? `${cleaned.slice(0, 87)}…` : cleaned;
}

function keyFromName(name: string, used: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!base) base = 'field';
  let key = `pdf_${base}`;
  let i = 2;
  while (used.has(key)) key = `pdf_${base}_${i++}`;
  used.add(key);
  return key;
}

// Prefill heuristics: bind obvious identity fields to the portal's
// standard PrefillSource values so the state card arrives pre-filled.
function prefillFor(name: string): string | null {
  const n = name.toLowerCase();
  if (/child.*name|student.*name/.test(n)) return 'student.full_name';
  if (/date of birth|birth ?date|dob/.test(n)) return 'student.date_of_birth';
  if (/^parent or guardian name$/.test(n)) return 'parent.full_name';
  if (/^home address$/.test(n)) return 'meta:student_street';
  if (/^email address$/.test(n)) return 'parent.email';
  if (/^phone$/.test(n)) return 'parent.phone';
  return null;
}

export async function POST(request: NextRequest, { params }: { params: Params }) {
  const { formId } = await params;
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const fd = await request.formData();
  const file = fd.get('file');
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const back = (q: { msg?: string; err?: string }) => {
    const url = request.nextUrl.clone();
    url.pathname = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : '/school';
    url.search = '';
    if (q.msg) url.searchParams.set('msg', q.msg);
    if (q.err) url.searchParams.set('err', q.err);
    return NextResponse.redirect(url, 303);
  };

  if (!file || !(file instanceof File) || file.size === 0) return back({ err: 'Pick a PDF file first.' });
  if (file.size > MAX_BYTES) return back({ err: 'PDF too large (max 10MB).' });

  const { rows: defRows } = await query<{ id: string; field_schema: Array<Record<string, unknown>> }>(
    `SELECT id, field_schema FROM portal_form_definitions WHERE id = $1 AND school_id = $2`,
    [formId, session.school_id],
  );
  if (defRows.length === 0) return back({ err: 'Form not found.' });

  const bytes = Buffer.from(await file.arrayBuffer());
  let inventory: InventoryEntry[];
  let pageCount: number;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pageCount = doc.getPageCount();
    inventory = doc.getForm().getFields().map((f): InventoryEntry => {
      const name = f.getName();
      if (f instanceof PDFTextField) return { name, type: 'text' };
      if (f instanceof PDFCheckBox) return { name, type: 'checkbox' };
      if (f instanceof PDFRadioGroup) return { name, type: 'radio', options: f.getOptions() };
      if (f instanceof PDFDropdown) return { name, type: 'dropdown', options: f.getOptions() };
      if (f instanceof PDFSignature) return { name, type: 'signature' };
      return { name, type: 'other' };
    });
  } catch (e) {
    return back({ err: `Couldn't read that PDF: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (inventory.length === 0) {
    return back({ err: 'This PDF has no fillable fields. Flat/scanned PDFs need the overlay editor (not yet available) — ask support.' });
  }

  // Auto-generate field blocks once — only when the form has no PDF-bound
  // blocks yet, so a re-upload never clobbers the office's relabeling.
  const existing = defRows[0].field_schema ?? [];
  const hasPdfBlocks = existing.some((b) => typeof b.pdf_field === 'string');
  let generated = 0;
  if (!hasPdfBlocks) {
    const used = new Set<string>(existing.map((b) => String(b.key ?? '')));
    const blocks: Array<Record<string, unknown>> = [];
    let sigSeen = false;
    for (const f of inventory) {
      if (f.type === 'other') continue;
      if (f.type === 'signature') {
        // The PDF's signature widget is where we stamp the typed signature.
        // Render our standard typed-signature block for the parent.
        if (!sigSeen) {
          blocks.push({
            type: 'signature_typed', key: 'parent_signature_typed',
            label: 'Type your full legal name to sign', required: true,
            pdf_field: f.name,
          });
          sigSeen = true;
        }
        continue;
      }
      const key = keyFromName(f.name, used);
      const prefill = prefillFor(f.name);
      blocks.push({
        type: f.type === 'checkbox' ? 'checkbox' : (f.type === 'radio' || f.type === 'dropdown') ? 'select' : 'text',
        key,
        label: labelFromName(f.name),
        required: false,
        pdf_field: f.name,
        ...(f.options?.length ? { options: f.options.map((o) => ({ value: o, label: o })) } : {}),
        ...(prefill ? { prefill } : {}),
      });
    }
    generated = blocks.length;
    await query(
      `UPDATE portal_form_definitions SET field_schema = $1::jsonb WHERE id = $2 AND school_id = $3`,
      [JSON.stringify([...existing, ...blocks]), formId, session.school_id],
    );
  }

  await query(
    `INSERT INTO portal_form_pdf_templates
       (school_id, form_definition_id, file_name, file_bytes, page_count, field_inventory)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (form_definition_id) DO UPDATE
       SET file_name = EXCLUDED.file_name,
           file_bytes = EXCLUDED.file_bytes,
           page_count = EXCLUDED.page_count,
           field_inventory = EXCLUDED.field_inventory,
           updated_at = now()`,
    [session.school_id, formId, file.name, bytes, pageCount, JSON.stringify(inventory)],
  );

  return back({
    msg: `PDF template saved — ${pageCount} page(s), ${inventory.length} fillable fields`
      + (generated > 0 ? `, ${generated} form fields generated (review labels below)` : ' (existing field mapping kept)')
      + '.',
  });
}
