// Cron endpoint — re-syncs every school's family-graph from GHL.
// Triggered by Vercel Cron (configured in vercel.json) and/or by an
// internal call from another service. Two auth modes:
//
//   1. Vercel Cron sets an `Authorization: Bearer <CRON_SECRET>` header
//      automatically (when CRON_SECRET is set as an env var).
//   2. Internal callers can use the same shared INTERNAL_API_TOKEN bearer
//      that all /api/v1 routes accept.
//
// Either matches → run. Neither → 401.
//
// Behavior: iterates every row in `schools` table that has a non-null
// PIT, runs runGhlSync for each, returns a summary. Failures per school
// are caught and reported in the response, never abort the whole run.

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { mirrorP2Tags } from '@/lib/sync/mirror-p2-tags';
import { importGhlDocuments } from '@/lib/sync/import-ghl-documents';
import { backfillProgramFromGrade } from '@/lib/sync/program-from-grade';
import { runGhlSync, type SyncResult } from '@/lib/sync/run-ghl-sync';
import { backfillStudentIds } from '@/lib/sync/student-id-backfill';
import { syncGhlAttributes } from '@/lib/sync/ghl-attributes';
import { createMissingEnrolledFamilies } from '@/lib/sync/create-family-from-contact';
import { generateDepositsForAcceptedFamilies } from '@/lib/billing/enrollment-deposits';

// Vercel cron may take longer than the default Hobby 10s; bump.
export const maxDuration = 300; // 5 min

interface SchoolRow {
  id: string;
  name: string;
  ghl_location_id: string;
  sync_mode: 'snapshot' | 'attributes_only' | 'off';
}

interface PerSchoolResult {
  school_id: string;
  name: string;
  location_id: string;
  ok: boolean;
  duration_ms: number;
  result?: SyncResult;
  error?: string;
}

export async function GET(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return runForAll();
}

// Allow POST so callers can fire-and-forget without a body
export async function POST(request: NextRequest) {
  if (!authorize(request)) return new NextResponse('unauthorized', { status: 401 });
  return runForAll();
}

function authorize(request: NextRequest): boolean {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length).trim();

  // Try CRON_SECRET first (what Vercel cron sends), then INTERNAL_API_TOKEN.
  const candidates = [
    process.env.CRON_SECRET,
    process.env.INTERNAL_API_TOKEN,
  ].filter((s): s is string => !!s && s.length > 0);

  for (const expected of candidates) {
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) continue;
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

async function runForAll(): Promise<NextResponse> {
  const started = Date.now();
  const { rows: schools } = await query<SchoolRow>(
    `SELECT id, name, ghl_location_id, COALESCE(sync_mode, 'snapshot') AS sync_mode
     FROM schools
     WHERE ghl_pit_encrypted IS NOT NULL
     ORDER BY name`,
  );

  const results: PerSchoolResult[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const s of schools) {
    if (s.sync_mode === 'off') continue;
    const t0 = Date.now();
    try {
      // Snapshot mode: full destructive family-graph rebuild from GHL.
      // attributes_only mode (import-managed rosters like DGM/MCH):
      // SKIP the destructive sync — their family graph is the source of
      // truth in OUR db; only the additive attribute layer refreshes.
      const result = s.sync_mode === 'snapshot' ? await runGhlSync(s.id) : null;

      // Attribute layer (tags / custom-field values / opportunities /
      // filter catalog) refreshes for every non-off school. Additive,
      // never touches the family graph.
      let attrSummary = '';
      try {
        const attrs = await syncGhlAttributes(s.id);
        attrSummary = ` Attributes: ${attrs.tag_rows} tags, ${attrs.field_value_rows} field values, ${attrs.opportunities} opps, ${attrs.catalog_attributes} catalog.`;
      } catch (attrErr) {
        attrSummary = ` Attributes FAILED: ${attrErr instanceof Error ? attrErr.message : String(attrErr)}`;
      }

      // Parent-2 tag mirror — promoted co-parent contacts pick up Parent 1's
      // tags (P1 = source of truth: adds AND removals of mirror-managed
      // tags) so automations and segments reach both parents without
      // double-counting. Gated on schools.settings.promote_parent2; diffs
      // come from the attribute snapshot refreshed just above.
      let p2TagSummary = '';
      try {
        const m = await mirrorP2Tags(s.id);
        if (m.ran && (m.tags_added > 0 || m.tags_removed > 0 || m.errors > 0)) {
          p2TagSummary = ` P2-tags: +${m.tags_added}/-${m.tags_removed} tag(s) → ${m.updated} contact(s)${m.errors ? `, ${m.errors} errors` : ''}.`;
        }
      } catch (mErr) {
        p2TagSummary = ` P2-tags FAILED: ${mErr instanceof Error ? mErr.message : String(mErr)}`;
      }

      // GHL Documents & Contracts completions — flips per-student tracking
      // fields (e.g. AZ card) when a signed document lands. Gated on
      // schools.settings.ghl_documents_sync.
      let docSummary = '';
      try {
        const dm = await importGhlDocuments(s.id);
        if (dm.ran && (dm.processed > 0 || dm.errors > 0)) {
          docSummary = ` GHL-docs: ${dm.processed} completion(s), ${dm.fields_set} field(s) set${dm.errors ? `, ${dm.errors} errors` : ''}.`;
        }
      } catch (dErr) {
        docSummary = ` GHL-docs FAILED: ${dErr instanceof Error ? dErr.message : String(dErr)}`;
      }

      // Program-from-grade backfill (settings.derive_program_from_grade).
      let pgSummary = '';
      try {
        const pg = await backfillProgramFromGrade(s.id);
        if (pg.ran && (pg.filled > 0 || pg.errors > 0)) {
          pgSummary = ` Program-from-grade: ${pg.filled} filled${pg.errors ? `, ${pg.errors} errors` : ''}.`;
        }
      } catch (pgErr) {
        pgSummary = ` Program-from-grade FAILED: ${pgErr instanceof Error ? pgErr.message : String(pgErr)}`;
      }

      // Enrollment trigger — for live, import-managed (attributes_only)
      // schools, create a loginable family for any contact whose opportunity
      // reached an "Enrolled" stage but isn't in the family graph yet.
      // Additive + idempotent; never touches existing families. Snapshot
      // schools are excluded — they already create families on their full
      // sync. Runs AFTER syncGhlAttributes so ghl_opportunities is fresh.
      let enrollSummary = '';
      if (s.sync_mode === 'attributes_only') {
        try {
          const enr = await createMissingEnrolledFamilies(s.id);
          if (enr.ran && (enr.created > 0 || enr.errors > 0)) {
            enrollSummary = ` Enroll-trigger: +${enr.created} portals, ${enr.skipped} skipped, ${enr.errors} errors.`;
          }
        } catch (enrErr) {
          enrollSummary = ` Enroll-trigger FAILED: ${enrErr instanceof Error ? enrErr.message : String(enrErr)}`;
        }
      }

      // Enrollment-deposit trigger — safety net for the "Offer Accepted"
      // webhook. For deposit-enabled attributes_only schools, invoice the
      // enrollment deposit for any family whose opportunity reached an
      // "accepted" stage after the feature's effective_from. Idempotent.
      let depositSummary = '';
      if (s.sync_mode === 'attributes_only') {
        try {
          const dep = await generateDepositsForAcceptedFamilies(s.id);
          if (dep.ran && (dep.created > 0 || dep.errors > 0)) {
            depositSummary = ` Deposits: +${dep.created} invoice(s) across ${dep.families} famil(ies)${dep.errors ? `, ${dep.errors} errors` : ''}.`;
          }
        } catch (depErr) {
          depositSummary = ` Deposit-trigger FAILED: ${depErr instanceof Error ? depErr.message : String(depErr)}`;
        }
      }

      // Auto-assign Student IDs to any new students missing one (opted-in
      // schools only). Generates a unique random 8-digit id, writes it to GHL
      // (source of truth) + mirrors to metadata. Best-effort.
      let sidSummary = '';
      try {
        const sid = await backfillStudentIds(s.id);
        if (sid.ran && (sid.assigned > 0 || sid.errors.length > 0)) {
          sidSummary = ` Student-IDs: +${sid.assigned} assigned (${sid.ghl_written} to GHL)${sid.errors.length ? `, ${sid.errors.length} errors` : ''}.`;
        }
      } catch (sidErr) {
        sidSummary = ` Student-IDs FAILED: ${sidErr instanceof Error ? sidErr.message : String(sidErr)}`;
      }

      const dur = Date.now() - t0;
      const summary = (result
        ? `Synced ${result.families_created} families, ${result.students_created} students, ${result.enrollments_created} enrollments, ${result.classrooms_created} classrooms.`
        : `Family-graph sync skipped (sync_mode=${s.sync_mode}).`) + attrSummary + p2TagSummary + docSummary + pgSummary + enrollSummary + depositSummary + sidSummary;
      results.push({
        school_id: s.id,
        name: s.name,
        location_id: s.ghl_location_id,
        ok: true,
        duration_ms: dur,
        result: result ?? undefined,
      });
      // Per-school audit row (so the school admin shows its own cron events)
      await query(
        `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
         VALUES ($1, '_sync', 'cron', $2, $3)`,
        [s.id, dur, summary],
      ).catch(() => undefined);
      okCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dur = Date.now() - t0;
      results.push({
        school_id: s.id,
        name: s.name,
        location_id: s.ghl_location_id,
        ok: false,
        duration_ms: dur,
        error: msg,
      });
      await query(
        `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, duration_ms, error)
         VALUES ($1, '_sync', 'cron', $2, $3)`,
        [s.id, dur, `FAILED: ${msg}`],
      ).catch(() => undefined);
      failCount++;
      console.error(`[cron/sync-all] ${s.name} failed:`, msg);
    }
  }

  // Sync health + operator alerting. A school that fails 3 runs in a row
  // (>= 15 min stale at the 5-min cadence) emails the platform operator;
  // re-alerts at most every 6 hours; sends a recovery note when a school
  // that alerted comes back. Best-effort — alerting can never fail the cron.
  try {
    await trackSyncHealth(results);
  } catch (e) {
    console.warn('[cron/sync-all] health tracking failed:', e instanceof Error ? e.message : String(e));
  }

  // Persist a high-level audit row in widget_fetch_log so operators can
  // see when the cron last ran (and whether anything failed).
  try {
    await query(
      `INSERT INTO widget_fetch_log (school_id, dashboard_slug, widget_id, error)
       VALUES (NULL, '_cron', 'sync-all',
               $1)`,
      [`ok=${okCount} fail=${failCount} duration_ms=${Date.now() - started}`],
    );
  } catch {
    // swallow — audit failure can't fail the cron
  }

  return NextResponse.json({
    ok: failCount === 0,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    schools_processed: schools.length,
    successes: okCount,
    failures: failCount,
    results,
  }, { status: failCount === 0 ? 200 : 207 /* multi-status */ });
}

const ALERT_THRESHOLD = 3;               // consecutive failures before emailing
const REALERT_HOURS = 6;                 // don't spam while it stays broken

async function trackSyncHealth(results: PerSchoolResult[]): Promise<void> {
  const alertTo = process.env.SYNC_ALERT_EMAIL || 'clint@getaims.co';
  const failing: Array<{ name: string; error: string; consecutive: number; since: string | null }> = [];
  const recovered: string[] = [];

  for (const r of results) {
    if (r.ok) {
      const { rows } = await query<{ consecutive_failures: number; last_alerted_at: string | null }>(
        `SELECT consecutive_failures, last_alerted_at FROM sync_health WHERE school_id = $1`,
        [r.school_id],
      );
      const prev = rows[0];
      if (prev && prev.consecutive_failures >= ALERT_THRESHOLD && prev.last_alerted_at) {
        recovered.push(r.name);
      }
      await query(
        `INSERT INTO sync_health (school_id, consecutive_failures, last_ok_at, last_error, last_alerted_at)
         VALUES ($1, 0, now(), NULL, NULL)
         ON CONFLICT (school_id) DO UPDATE
           SET consecutive_failures = 0, last_ok_at = now(), last_error = NULL, last_alerted_at = NULL`,
        [r.school_id],
      );
    } else {
      const { rows } = await query<{ consecutive_failures: number; last_alerted_at: string | null; last_ok_at: string | null }>(
        `INSERT INTO sync_health (school_id, consecutive_failures, last_error, last_failure_at)
         VALUES ($1, 1, $2, now())
         ON CONFLICT (school_id) DO UPDATE
           SET consecutive_failures = sync_health.consecutive_failures + 1,
               last_error = EXCLUDED.last_error, last_failure_at = now()
         RETURNING consecutive_failures, last_alerted_at, last_ok_at`,
        [r.school_id, r.error ?? 'unknown error'],
      );
      const h = rows[0];
      const staleForAlert = !h.last_alerted_at
        || (Date.now() - new Date(h.last_alerted_at).getTime()) > REALERT_HOURS * 3600_000;
      if (h.consecutive_failures >= ALERT_THRESHOLD && staleForAlert) {
        failing.push({ name: r.name, error: r.error ?? 'unknown', consecutive: h.consecutive_failures, since: h.last_ok_at });
      }
    }
  }

  if (failing.length === 0 && recovered.length === 0) return;
  const { sendBrandedEmail } = await import('@/lib/email');

  if (failing.length > 0) {
    const lines = failing.map((f) =>
      `${f.name}: ${f.consecutive} consecutive failures${f.since ? ` (last good sync ${f.since})` : ''}
  ${f.error}`);
    await sendBrandedEmail({
      to: alertTo,
      schoolId: null,
      subject: `Growth Suite sync FAILING — ${failing.map((f) => f.name).join(', ')}`,
      text: `The data sync is failing repeatedly for:

${lines.join('\n\n')}

Dashboards and portals for these schools are serving stale data until this is fixed. This alert repeats every ${REALERT_HOURS}h while the failure continues.`,
      html: `<p>The data sync is failing repeatedly for:</p><ul>${failing.map((f) =>
        `<li><strong>${f.name}</strong> — ${f.consecutive} consecutive failures${f.since ? ` (last good sync ${f.since})` : ''}<br><code>${f.error.replace(/</g, '&lt;')}</code></li>`).join('')}</ul><p>Dashboards and portals for these schools are serving stale data until this is fixed. This alert repeats every ${REALERT_HOURS}h while the failure continues.</p>`,
    });
    for (const r of results) {
      if (!r.ok && failing.some((f) => f.name === r.name)) {
        await query(`UPDATE sync_health SET last_alerted_at = now() WHERE school_id = $1`, [r.school_id]);
      }
    }
  }

  if (recovered.length > 0) {
    await sendBrandedEmail({
      to: alertTo,
      schoolId: null,
      subject: `Growth Suite sync recovered — ${recovered.join(', ')}`,
      text: `Sync is healthy again for: ${recovered.join(', ')}. Data is current as of this run.`,
      html: `<p>Sync is healthy again for: <strong>${recovered.join(', ')}</strong>. Data is current as of this run.</p>`,
    });
  }
}
