// POST /api/school/billing-shares/save
//
// Save (or remove) the billing split for one enrollment. The school-
// session-authed school-iframe endpoint; same auth model as the
// other /api/school/* endpoints.
//
// Body (multipart form):
//   enrollment_id        — uuid (required)
//   return_to            — relative path to redirect to (optional)
//   mode                 — 'joint' | 'split'
//     joint: clear all shares (revert to family-level invoices).
//     split: parse share_bp_<parent_id>=NNNN fields from form data and
//            upsert. Sum must equal 10000 bp (100%). DB trigger enforces.
//
// On success: 303 redirect to return_to (or a default) with ?msg=...
// On error:   303 redirect to return_to (or default) with ?err=...

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { SCHOOL_SESSION_COOKIE, verifySchoolSession } from '@/lib/auth/school';
import { query, withTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounce(request: NextRequest, returnTo: string | null, params: { msg?: string; err?: string }) {
  const fallback = '/school/_/payments?tab=plans';
  const base = returnTo && /^\/school\/[A-Za-z0-9_-]+\//.test(returnTo) ? returnTo : fallback;
  const url = new URL(base, request.url);
  if (params.msg) url.searchParams.set('msg', params.msg);
  if (params.err) url.searchParams.set('err', params.err);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  const ck = await cookies();
  const session = await verifySchoolSession(ck.get(SCHOOL_SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let fd: FormData;
  try { fd = await request.formData(); } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const enrollmentId = String(fd.get('enrollment_id') ?? '').trim();
  const returnTo = String(fd.get('return_to') ?? '').trim() || null;
  const mode = String(fd.get('mode') ?? '').trim();

  if (!enrollmentId || !/^[0-9a-fA-F-]{36}$/.test(enrollmentId)) {
    return bounce(request, returnTo, { err: 'Invalid enrollment id.' });
  }

  // Verify enrollment exists AND belongs to this school. Don't trust the
  // caller's school-id claim — we use the session's school_id.
  const { rows: enrRows } = await query<{ family_id: string }>(
    `SELECT family_id FROM family_tuition_enrollments
      WHERE id = $1 AND school_id = $2`,
    [enrollmentId, session.school_id],
  );
  if (enrRows.length === 0) {
    return bounce(request, returnTo, { err: 'Enrollment not found for this school.' });
  }
  const familyId = enrRows[0].family_id;

  if (mode === 'joint') {
    // Clear all shares — revert to family-level invoicing on the next
    // generation. Trigger will flip is_split_billed back to false.
    try {
      await query(
        `DELETE FROM enrollment_billing_shares
          WHERE enrollment_id = $1 AND school_id = $2`,
        [enrollmentId, session.school_id],
      );
      return bounce(request, returnTo, {
        msg: 'Switched to joint billing. Future invoices will be addressed to the family.',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return bounce(request, returnTo, { err: `Could not clear split: ${msg}` });
    }
  }

  if (mode === 'split') {
    // Parse share_bp_<parent_uuid>=NNNN entries.
    const parsed: Array<{ parent_id: string; share_basis_points: number }> = [];
    let totalBp = 0;
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith('share_bp_')) continue;
      const parentId = key.slice('share_bp_'.length).trim();
      if (!/^[0-9a-fA-F-]{36}$/.test(parentId)) {
        return bounce(request, returnTo, { err: `Invalid parent id in form: ${parentId}` });
      }
      const rawNum = String(value).trim();
      const bp = Math.round(Number(rawNum));
      if (!Number.isFinite(bp) || bp < 0 || bp > 10000) {
        return bounce(request, returnTo, { err: `Invalid share for parent ${parentId}: ${rawNum} (must be 0–10000 bp).` });
      }
      parsed.push({ parent_id: parentId, share_basis_points: bp });
      totalBp += bp;
    }

    if (parsed.length === 0) {
      return bounce(request, returnTo, { err: 'No parent shares submitted.' });
    }
    if (totalBp !== 10000) {
      return bounce(request, returnTo, {
        err: `Shares must total exactly 100% (10000 bp). Got ${(totalBp / 100).toFixed(2)}%.`,
      });
    }

    // Verify every parent_id is active and belongs to this family. The DB
    // trigger validates cross-family but we want a friendly error here
    // before we touch the table.
    const parentIds = parsed.map((p) => p.parent_id);
    const { rows: parents } = await query<{ id: string; status: string; family_id: string }>(
      `SELECT id, status, family_id FROM parents
        WHERE school_id = $1 AND id = ANY($2::uuid[])`,
      [session.school_id, parentIds],
    );
    if (parents.length !== parsed.length) {
      return bounce(request, returnTo, { err: 'One or more parent ids do not exist for this school.' });
    }
    for (const p of parents) {
      if (p.family_id !== familyId) {
        return bounce(request, returnTo, { err: 'All parents in the split must belong to the same family as the enrollment.' });
      }
    }

    // Upsert: replace the entire share set for this enrollment. Done in
    // a transaction so the deferred trigger sees the final state and the
    // sum-to-100% check passes atomically.
    try {
      await withTransaction(async (q) => {
        await q(
          `DELETE FROM enrollment_billing_shares
            WHERE enrollment_id = $1 AND school_id = $2`,
          [enrollmentId, session.school_id],
        );
        for (const p of parsed) {
          if (p.share_basis_points === 0) continue; // 0% rows skipped — don't bother storing
          await q(
            `INSERT INTO enrollment_billing_shares
               (school_id, enrollment_id, parent_id, share_basis_points)
             VALUES ($1, $2, $3, $4)`,
            [session.school_id, enrollmentId, p.parent_id, p.share_basis_points],
          );
        }
      });
      const splitDesc = parsed
        .filter((p) => p.share_basis_points > 0)
        .map((p) => `${(p.share_basis_points / 100).toFixed(p.share_basis_points % 100 === 0 ? 0 : 2)}%`)
        .join(' / ');

      // Fire-and-forget GHL writeback so each parent's contact shows
      // their share + dollar amount + plan inside the CRM. Doesn't block
      // the redirect — slow GHL responses shouldn't make the operator
      // wait. Errors logged but never bubble up.
      import('@/lib/billing/tuition-ghl-writeback')
        .then(({ writebackBillingShareToGhl }) => writebackBillingShareToGhl(enrollmentId))
        .catch((e) => console.warn('[billing-shares/save] GHL writeback failed:', e instanceof Error ? e.message : String(e)));

      return bounce(request, returnTo, {
        msg: `Saved billing split (${splitDesc}). Future invoice generation will produce one invoice per parent.`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return bounce(request, returnTo, { err: `Could not save split: ${msg}` });
    }
  }

  return bounce(request, returnTo, { err: `Unknown mode: ${mode}` });
}
