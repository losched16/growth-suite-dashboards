// DonorDashboard — the one-stop donors view for a school. Combines:
//   - Stat cards (lifetime, school-year YTD, retention, major-donor count)
//   - Segment breakdowns + tag tiles
//   - School-year-over-school-year annual report
//   - Top donors list
//   - Full searchable/filterable donor directory with inline accordion
//
// All sections are filterable from one URL — directory filters drive the
// directory pagination only; stats/segments/annual are always full-school.

import type { WidgetDefinition, SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import {
  donorDashboardDefaults,
  donorDashboardSchema,
  type DonorDashboardConfig,
} from './config';
import { fetcher, type DonorDashboardData } from './fetcher';
import { DirectoryTable } from './DirectoryTable';
import { AutoSubmitForm } from '@/lib/widgets/components/_shared/AutoSubmitForm';
import { PreserveEmbedParams, clearHref } from '@/lib/widgets/components/_shared/PreserveEmbedParams';
import { crmAppBase } from '@/lib/ghl/contact-url';

function StatCard({
  label,
  value,
  sub,
  color = '#111827',
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  href?: string;          // when set, the card is a click-through filter
}) {
  const body = (
    <>
      <div className="text-2xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      {sub ? <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div> : null}
    </>
  );
  return href ? (
    <a
      href={href}
      className="block rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-emerald-400 hover:bg-emerald-50/30"
    >
      {body}
      <div className="mt-1 text-[10px] text-emerald-700">click to filter →</div>
    </a>
  ) : (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">{body}</div>
  );
}

// Build a filtered href that keeps embed/chrome but resets pagination.
function filterHref(current: WidgetSearchParams, set: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    // Reset any URL param that overlaps with directory filtering when
    // the operator clicks a stat card — they're navigating to a fresh
    // filtered view, not stacking onto whatever's already there.
    if (v && k !== 'page' && k !== 'segment' && k !== 'tag' && k !== 'giving'
         && k !== 'state' && k !== 'q' && k !== 'campaign') {
      p.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(set)) {
    if (v) p.set(k, v);
  }
  return `?${p.toString()}#directory`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtCompactMoney(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function Component({
  school,
  data,
  searchParams,
}: {
  school: SchoolContext;
  config: DonorDashboardConfig;
  data: DonorDashboardData;
  searchParams?: WidgetSearchParams;
}) {
  const sp = searchParams ?? {};
  const yr = data.current_school_year_label;
  const maxBucket = Math.max(...data.annual_buckets.map((b) => b.total_amount), 1);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-emerald-700">Donors</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          {data.total_directory.toLocaleString()} donors on file ·{' '}
          {data.stats.lifetime_gifts.toLocaleString()} gifts ·{' '}
          lifetime {fmtMoney(data.stats.lifetime_raised)} raised
        </p>
      </div>

      {/* Top stat row — YTD focused. Cards with filter targets are
          clickable; they jump to the directory pre-filtered. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={`Raised — ${yr}`}
          value={fmtCompactMoney(data.stats.ytd_raised)}
          sub={`${data.stats.ytd_donors} donors · ${data.stats.ytd_gifts} gifts`}
          color="#047857"
          href={filterHref(sp, { giving: 'ytd', sort: 'ytd' })}
        />
        <StatCard
          label="Avg gift YTD"
          value={fmtMoney(data.stats.ytd_avg_gift)}
        />
        <StatCard
          label="Major donors YTD"
          value={String(data.stats.major_donor_count)}
          sub={`≥ $1k this year`}
          color="#1d4ed8"
          href={filterHref(sp, { giving: 'major', sort: 'ytd' })}
        />
        <StatCard
          label="Retention"
          value={`${data.stats.retention_pct}%`}
          sub={`of last yr donors`}
          color={data.stats.retention_pct >= 50 ? '#047857' : '#d97706'}
        />
        <StatCard
          label="Current-family donors"
          value={String(data.stats.current_family_donors)}
          sub="parents who give"
          href={filterHref(sp, { segment: 'current_family', sort: 'lifetime' })}
        />
        <StatCard
          label="Lifetime raised"
          value={fmtCompactMoney(data.stats.lifetime_raised)}
          sub={`${data.stats.lifetime_donors} unique donors`}
          href={filterHref(sp, { giving: 'major_lifetime', sort: 'lifetime' })}
        />
      </div>

      {/* Segment breakdown tiles */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Segments</h3>
          <p className="text-[11px] text-gray-500">click a tile to filter the directory below</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {data.segment_breakdowns.map((s) => {
            const isTag = s.segment.startsWith('tag:');
            const label = isTag ? s.segment.slice(4).replace(/_/g, ' ') : s.segment.replace(/_/g, ' ');
            const filterParams = new URLSearchParams();
            for (const [k, v] of Object.entries(sp)) {
              if (v && k !== 'segment' && k !== 'tag' && k !== 'page') filterParams.set(k, v);
            }
            if (isTag) filterParams.set('tag', s.segment.slice(4));
            else filterParams.set('segment', s.segment);
            const href = `?${filterParams.toString()}#directory`;
            return (
              <a
                key={s.segment}
                href={href}
                className="rounded-md border border-gray-200 px-3 py-2 hover:border-emerald-400 hover:bg-emerald-50/30"
              >
                <div className="text-[10px] uppercase tracking-wide text-gray-500 truncate">
                  {isTag ? '#' : ''}{label}
                </div>
                <div className="mt-0.5 text-lg font-semibold text-gray-900 tabular-nums">{s.donor_count}</div>
                <div className="text-[11px] text-gray-600 tabular-nums">
                  {fmtCompactMoney(s.total_ytd)} YTD
                </div>
              </a>
            );
          })}
        </div>
      </div>

      {/* Campaigns + Sponsorship tiers — populated by the DonorPerfect
          "Flags" export. Each tile is clickable to filter the directory
          below to donors who gave via that campaign. */}
      {(data.campaign_breakdowns.length > 0 || data.uncoded_gift_count > 0) ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-900">Campaigns</h3>
            <p className="text-[11px] text-gray-500">click a tile to filter the directory below</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {data.campaign_breakdowns.map((c) => {
              const filterParams = new URLSearchParams();
              for (const [k, v] of Object.entries(sp)) {
                if (v && k !== 'campaign' && k !== 'page') filterParams.set(k, v);
              }
              filterParams.set('campaign', c.slug);
              const isActive = (sp.campaign ?? '').toLowerCase() === c.slug.toLowerCase();
              return (
                <a
                  key={c.slug}
                  href={`?${filterParams.toString()}#directory`}
                  className={`rounded-md border px-3 py-2 ${
                    isActive
                      ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-300'
                      : 'border-gray-200 hover:border-emerald-400 hover:bg-emerald-50/30'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 truncate" title={c.label}>
                    {c.label}
                  </div>
                  <div className="mt-0.5 text-lg font-semibold text-gray-900 tabular-nums">
                    {fmtCompactMoney(c.total_amount)}
                  </div>
                  <div className="text-[11px] text-gray-600 tabular-nums">
                    {c.donor_count} donor{c.donor_count === 1 ? '' : 's'} · {c.gift_count} gift{c.gift_count === 1 ? '' : 's'}
                  </div>
                </a>
              );
            })}
            {data.uncoded_gift_count > 0 ? (
              <div
                className="rounded-md border border-dashed border-amber-300 bg-amber-50/40 px-3 py-2"
                title="Gifts with no campaign attribution in DonorPerfect. Tag them there to see them roll up into a campaign here."
              >
                <div className="text-[10px] uppercase tracking-wide text-amber-700 truncate">
                  Uncoded
                </div>
                <div className="mt-0.5 text-lg font-semibold text-amber-900 tabular-nums">
                  {fmtCompactMoney(data.uncoded_gift_total)}
                </div>
                <div className="text-[11px] text-amber-700 tabular-nums">
                  {data.uncoded_gift_count} gift{data.uncoded_gift_count === 1 ? '' : 's'} · needs tagging
                </div>
              </div>
            ) : null}
          </div>

          {data.tier_breakdowns.length > 0 ? (
            <>
              <div className="mt-4 mb-2 flex items-baseline justify-between">
                <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Sponsorship tiers</h4>
                <p className="text-[11px] text-gray-500">tier is the SUB_SOLICIT_CODE</p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {data.tier_breakdowns.map((t) => (
                  <div
                    key={t.label}
                    className="rounded-md border border-gray-200 bg-gray-50/30 px-3 py-2"
                  >
                    <div className="text-[10px] uppercase tracking-wide text-gray-500 truncate" title={t.label}>
                      {t.label}
                    </div>
                    <div className="mt-0.5 text-lg font-semibold text-gray-900 tabular-nums">
                      {fmtCompactMoney(t.total_amount)}
                    </div>
                    <div className="text-[11px] text-gray-600 tabular-nums">
                      {t.gift_count} gift{t.gift_count === 1 ? '' : 's'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {sp.campaign ? (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-emerald-800">
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold">
                Directory filtered: campaign = {sp.campaign}
              </span>
              <a
                href={(() => {
                  const p = new URLSearchParams();
                  for (const [k, v] of Object.entries(sp)) {
                    if (v && k !== 'campaign' && k !== 'page') p.set(k, v);
                  }
                  return `?${p.toString()}#directory`;
                })()}
                className="text-emerald-700 hover:underline"
              >clear ×</a>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Annual report */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Annual giving (school year)</h3>
          <p className="text-[11px] text-gray-500">
            Year boundary: July 1 · auto-bar by total raised
          </p>
        </div>
        <div className="space-y-1.5">
          {data.annual_buckets.map((b) => (
            <div key={b.label} className="flex items-center gap-2 text-xs">
              <div className="w-16 font-medium text-gray-700 tabular-nums">{b.label}</div>
              <div className="flex-1 bg-gray-50 rounded h-6 relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-500/80 rounded"
                  style={{ width: `${Math.max(1, (b.total_amount / maxBucket) * 100)}%` }}
                />
                <div className="absolute inset-0 flex items-center px-2 text-[11px]">
                  <span className="font-semibold text-gray-900 tabular-nums">{fmtMoney(b.total_amount)}</span>
                </div>
              </div>
              <div className="w-44 text-right text-[11px] text-gray-600 tabular-nums">
                {b.donor_count} donors · {b.gift_count} gifts · {b.new_donor_count} new
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Top donors */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="flex items-baseline justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Top donors (lifetime)</h3>
          <p className="text-[11px] text-gray-500">{data.top_donors.length} shown · sorted by total given</p>
        </div>
        {data.top_donors.length === 0 ? (
          <div className="p-4 text-xs text-gray-500 italic">No donor history yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50/60">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Donor</th>
                <th className="px-3 py-2 font-medium">Segment</th>
                <th className="px-3 py-2 font-medium text-right">Lifetime</th>
                <th className="px-3 py-2 font-medium text-right">YTD</th>
                <th className="px-3 py-2 font-medium text-right">Gifts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.top_donors.map((d, i) => (
                <tr key={d.id}>
                  <td className="px-3 py-1.5 text-[11px] text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-1.5">
                    <div className="text-gray-900">{d.full_name}</div>
                    {d.email ? <div className="text-[11px] text-gray-500 truncate max-w-[36ch]">{d.email}</div> : null}
                  </td>
                  <td className="px-3 py-1.5 text-[11px] text-gray-600">
                    {d.inferred_segment?.replace(/_/g, ' ') ?? '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmtMoney(d.gift_total)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.ytd_school_year > 0 ? fmtMoney(d.ytd_school_year) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{d.gift_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Directory */}
      <div id="directory" className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-emerald-700">Donor directory</h3>
          <p className="text-[11px] text-gray-500">
            {data.filtered_count.toLocaleString()} of {data.total_directory.toLocaleString()} donors
          </p>
        </div>

        <AutoSubmitForm className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3">
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ''}
            placeholder="Search name, email, city, notes…"
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-200"
          />
          <label className="text-xs text-gray-600">
            Segment:{' '}
            <select name="segment" defaultValue={sp.segment ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
              <option value="">all</option>
              <option value="business">Business</option>
              <option value="current_family">Current family</option>
              <option value="alumni_family">Alumni family</option>
              <option value="individual">Individual</option>
            </select>
          </label>
          {data.all_tags.length > 0 ? (
            <label className="text-xs text-gray-600">
              Tag:{' '}
              <select name="tag" defaultValue={sp.tag ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
                <option value="">all</option>
                {data.all_tags.map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-xs text-gray-600">
            Giving:{' '}
            <select name="giving" defaultValue={sp.giving ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
              <option value="">all</option>
              <option value="ytd">Gave this year</option>
              <option value="major">Major donors (this yr)</option>
              <option value="mid">Mid-level donors (this yr)</option>
              <option value="grass">Grassroots (this yr)</option>
              <option value="major_lifetime">Major donors (lifetime)</option>
              <option value="lapsed">Lapsed (18+ mo)</option>
            </select>
          </label>
          <label className="text-xs text-gray-600">
            Sort:{' '}
            <select name="sort" defaultValue={sp.sort ?? 'lifetime'} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
              <option value="lifetime">Largest lifetime gift</option>
              <option value="ytd">Largest this year</option>
              <option value="last_gift">Most recent gift</option>
              <option value="name">Name (A-Z)</option>
            </select>
          </label>
          <label className="text-xs text-gray-600">
            State:{' '}
            <select name="state" defaultValue={sp.state ?? ''} className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-emerald-600 focus:outline-none">
              <option value="">all</option>
              {data.options.states.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          {/* Don't pin `dir` here — the fetcher picks the intuitive
              default per sort key (name = asc, $/date = desc). If the
              operator explicitly flipped via a column header link,
              preserve it. */}
          {sp.dir ? <input type="hidden" name="dir" value={sp.dir} /> : null}
          {sp.per_page ? <input type="hidden" name="per_page" value={sp.per_page} /> : null}
          <PreserveEmbedParams current={sp} />
          <noscript>
            <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
              Apply
            </button>
          </noscript>
          {(sp.q || sp.segment || sp.tag || sp.giving || sp.state) ? (
            <a href={clearHref(sp)} className="text-xs text-gray-500 hover:underline">clear</a>
          ) : null}
        </AutoSubmitForm>

        <DirectoryTable
          rows={data.directory_rows}
          current={sp}
          locationId={school.locationId}
          crmAppBase={crmAppBase()}
        />

        {/* Pagination */}
        <div className="flex items-center justify-between text-xs text-gray-600 px-1">
          <span>
            Page {data.page} of {data.page_count} · {data.per_page}/page
          </span>
          <div className="flex gap-2">
            {data.page > 1 ? (
              <a href={pageUrl(sp, data.page - 1)} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50">‹ Prev</a>
            ) : null}
            {data.page < data.page_count ? (
              <a href={pageUrl(sp, data.page + 1)} className="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50">Next ›</a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function pageUrl(current: WidgetSearchParams, page: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && k !== 'page') p.set(k, v);
  }
  p.set('page', String(page));
  return `?${p.toString()}#directory`;
}

export const DonorDashboard: WidgetDefinition<DonorDashboardConfig, DonorDashboardData> = {
  id: 'donor_dashboard',
  display_name: 'Donor Dashboard (rich)',
  description:
    'Stat cards + segments + annual report + top donors + searchable directory ' +
    'with inline accordion. Source: DonorPerfect Bio + Gifts imports.',
  category: 'family',
  default_config: donorDashboardDefaults,
  config_schema: donorDashboardSchema,
  default_size: { w: 12, h: 24 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: true,
};
