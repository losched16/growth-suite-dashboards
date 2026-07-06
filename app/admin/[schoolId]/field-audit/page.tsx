// /admin/[schoolId]/field-audit — run the GHL field contract audit against
// the school's live custom fields. The go-to page right after connecting a
// new school (and re-runnable any time): shows exactly what will sync, what
// will silently degrade, and what to collect at intake (each school's own
// grade/classroom naming).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Info, RefreshCw, Wand2 } from 'lucide-react';
import { query } from '@/lib/db';
import { loadGhlClient } from '@/lib/ghl/client';
import { auditGhlFields, type GhlFieldDef, type AuditLevel } from '@/lib/onboarding/field-audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Params = Promise<{ schoolId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LEVEL_STYLE: Record<AuditLevel, { icon: typeof CheckCircle2; cls: string; badge: string }> = {
  ok:   { icon: CheckCircle2,  cls: 'border-emerald-200 bg-emerald-50/50', badge: 'text-emerald-700' },
  warn: { icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50/60',     badge: 'text-amber-700' },
  fail: { icon: XCircle,       cls: 'border-rose-300 bg-rose-50/60',       badge: 'text-rose-700' },
  info: { icon: Info,          cls: 'border-slate-200 bg-white',           badge: 'text-slate-500' },
};

export default async function FieldAuditPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { schoolId } = await params;
  const sp = await searchParams;
  const msg = typeof sp.msg === 'string' ? sp.msg : null;
  const errMsg = typeof sp.err === 'string' ? sp.err : null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM schools WHERE id = $1`, [schoolId]);
  if (rows.length === 0) notFound();
  const school = rows[0];

  let error: string | null = null;
  let result: ReturnType<typeof auditGhlFields> | null = null;
  try {
    const client = await loadGhlClient(schoolId);
    const { data } = await client.axios.get<{ customFields?: GhlFieldDef[] }>(
      `/locations/${client.locationId}/customFields`);
    result = auditGhlFields(data.customFields ?? []);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const order: AuditLevel[] = ['fail', 'warn', 'ok', 'info'];
  const items = result ? [...result.items].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)) : [];

  return (
    <main className="flex flex-1 flex-col items-center bg-zinc-50 p-6 min-h-screen">
      <div className="w-full max-w-2xl space-y-4">
        <Link href={`/admin/${schoolId}`} className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700">
          <ArrowLeft className="h-3 w-3" /> Back to {school.name}
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900">GHL field audit</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Checks this location&rsquo;s custom fields against the platform contract — structure is standardized, the school&rsquo;s own grade/classroom names are collected at intake.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Push the field kit using the school's stored PIT. Idempotent —
                fills only what's missing, safe on a fully-provisioned location. */}
            <form action={`/api/admin/schools/${schoolId}/provision-fields`} method="POST">
              <button type="submit"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                title="Create any missing Growth Suite fields on this location (idempotent)">
                <Wand2 className="h-3.5 w-3.5" /> Provision missing fields
              </button>
            </form>
            <Link href={`/admin/${schoolId}/field-audit`}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
              <RefreshCw className="h-3.5 w-3.5" /> Re-run
            </Link>
          </div>
        </div>

        {msg ? <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</div> : null}
        {errMsg ? <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{errMsg}</div> : null}

        {error ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800">
            Couldn&rsquo;t read the location&rsquo;s custom fields: {error}
          </div>
        ) : result ? (
          <>
            <div className={`rounded-lg border p-4 text-sm ${result.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-rose-300 bg-rose-50 text-rose-900'}`}>
              {result.ok
                ? '✓ Ready to sync — no blocking problems found.'
                : '✕ Blocking problems found — fix the items below (or import the field kit snapshot) before the first sync.'}
            </div>
            <ul className="space-y-2">
              {items.map((it, i) => {
                const s = LEVEL_STYLE[it.level];
                const Icon = s.icon;
                return (
                  <li key={i} className={`rounded-lg border p-3 ${s.cls}`}>
                    <div className="flex items-start gap-2">
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.badge}`} />
                      <div>
                        <div className="text-sm font-medium text-zinc-900">{it.title}</div>
                        {it.detail ? <div className="mt-0.5 text-xs text-zinc-600">{it.detail}</div> : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </main>
  );
}
