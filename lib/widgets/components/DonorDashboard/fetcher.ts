// DonorDashboard data fetcher. One big roll-up + the directory rows
// with bio + gift history attached for the inline accordion.

import { query } from '@/lib/db';
import type { SchoolContext, WidgetSearchParams } from '@/lib/widgets/types';
import type { DonorDashboardConfig } from './config';

export interface DonorGift {
  id: string;
  gift_date: string | null;     // ISO YYYY-MM-DD
  amount: number;
  dp_gift_id: string;
  // Campaign attribution + relationship notes added by migration 029.
  // Most gifts only have a subset populated.
  solicit_code: string | null;          // 'DREAM2024'
  solicit_code_descr: string | null;    // 'Dream 2024'
  sub_solicit_code_descr: string | null;// 'Bronze Sponsor ($1000)'
  narrative: string | null;             // operator notes
}

export interface DonorRow {
  id: string;
  dp_donor_id: string;
  // Display
  full_name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  // Org / segment
  org_rec: 'Y' | 'N' | null;
  inferred_segment: string | null;
  tags: string[];
  // Aggregates
  gift_total: number;            // lifetime
  ytd_school_year: number;       // current school year
  last_school_year: number;
  last_gift_date: string | null;
  gift_count: number;
  // Family link
  matched_family_id: string | null;
  matched_parent_id: string | null;
  matched_parent_ghl_contact_id: string | null;
  match_method: string | null;
  // Best GHL contact id to deep-link the donor to. Picks the direct GHL
  // lookup result (dp_donors.ghl_contact_id) when present, else falls
  // back to the matched parent's GHL contact. Computed at fetch time
  // so the UI doesn't have to know about the precedence.
  best_ghl_contact_id: string | null;
  ghl_lookup_result: string | null;
  // Narrative
  additional_notes: string | null;
  vol_additional: string | null;
  social_media: string | null;
  linkedin: string | null;
  facebook: string | null;
  // Operator-editable free-form notes. Never overwritten by DP imports.
  // Edited inline in the donor accordion via /api/school/donor-notes/save.
  school_notes: string | null;
  school_notes_updated_at: string | null;
  // Per-gift narratives, deduplicated. Many DGM gifts share the same
  // long narrative (the operator copy-pastes touchpoint logs across
  // gifts on the same donor) — deduping makes the accordion readable.
  narratives: string[];
  // Distinct solicit_code_descr values across this donor's gifts —
  // a quick "which campaigns has this donor ever supported?" badge row.
  campaigns: string[];
  // Gift history for accordion (sorted desc by date)
  gifts: DonorGift[];
  // Pre-lowercased search blob
  search_haystack: string;
}

export interface YearBucket {
  label: string;                  // "2024-25" or "2024"
  start_iso: string;              // start of year (inclusive)
  end_iso: string;                // start of next year (exclusive)
  total_amount: number;
  gift_count: number;
  donor_count: number;            // unique donors who gave in this year
  new_donor_count: number;        // donors whose FIRST EVER gift is in this year
  retained_count: number;         // donors who also gave in the prior year
}

export interface SegmentBreakdown {
  segment: string;                // 'business' / 'current_family' / 'alumni_family' / 'individual' / 'tag:<slug>'
  donor_count: number;
  total_ytd: number;              // total given this school year
  total_lifetime: number;
}

export interface CampaignBreakdown {
  label: string;        // display name — solicit_code_descr ?? solicit_code
  slug: string;         // canonical filter value — solicit_code if present, else solicit_code_descr
  gift_count: number;
  donor_count: number;
  total_amount: number; // lifetime sum across this campaign
}

export interface TierBreakdown {
  label: string;        // sub_solicit_code_descr
  gift_count: number;
  total_amount: number;
}

export interface DonorDashboardData {
  stats: {
    lifetime_raised: number;
    lifetime_gifts: number;
    lifetime_donors: number;      // donors with ≥1 gift on record
    ytd_raised: number;           // current school year
    ytd_donors: number;
    ytd_gifts: number;
    ytd_avg_gift: number;
    ly_raised: number;            // last school year
    ly_donors: number;
    retention_pct: number;        // pct of last-year donors who also gave this year
    major_donor_count: number;    // YTD >= major threshold
    current_family_donors: number;
  };
  current_school_year_label: string;
  segment_breakdowns: SegmentBreakdown[];
  campaign_breakdowns: CampaignBreakdown[]; // sorted by total_amount desc
  tier_breakdowns: TierBreakdown[];         // sorted by total_amount desc
  uncoded_gift_count: number;               // gifts with no solicit_code
  uncoded_gift_total: number;
  annual_buckets: YearBucket[];   // most recent year LAST
  top_donors: DonorRow[];         // sorted by lifetime desc, capped
  directory_rows: DonorRow[];     // all donors, post-filter, post-sort
  all_tags: string[];
  // Filter options surfaced to the FilterRow
  options: {
    states: string[];
    cities: string[];
  };
  page: number;
  per_page: number;
  page_count: number;
  total_directory: number;        // pre-filter
  filtered_count: number;
}

// ----- helpers --------------------------------------------------------------

function schoolYearWindow(now: Date, startMonth: number): { startIso: string; endIso: string; label: string } {
  // School year that contains `now`. startMonth = 1..12 ; calendar year if 1.
  const m = startMonth;
  const y = now.getFullYear();
  const beforeStart = (now.getMonth() + 1) < m;
  const startYear = beforeStart ? y - 1 : y;
  const start = new Date(Date.UTC(startYear, m - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, m - 1, 1));
  const label =
    m === 1
      ? `${startYear}`
      : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return {
    startIso: start.toISOString().slice(0, 10),
    endIso: end.toISOString().slice(0, 10),
    label,
  };
}

function priorSchoolYearWindow(now: Date, startMonth: number) {
  // Year before the one containing `now`.
  const offset = new Date(now);
  offset.setFullYear(now.getFullYear() - 1);
  return schoolYearWindow(offset, startMonth);
}

function schoolYearLabelForDate(d: Date, startMonth: number): string {
  const m = startMonth;
  const y = d.getUTCFullYear();
  const beforeStart = (d.getUTCMonth() + 1) < m;
  const startYear = beforeStart ? y - 1 : y;
  return m === 1
    ? `${startYear}`
    : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ----- fetcher --------------------------------------------------------------

interface RawDonorRow {
  id: string;
  dp_donor_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  home_phone: string | null;
  business_phone: string | null;
  city: string | null;
  state: string | null;
  org_rec: string | null;
  inferred_segment: string | null;
  gift_total: string | null;
  ytd_amount: string | null;
  ly_amount: string | null;
  gift_count: string | null;
  last_gift_date: string | null;
  matched_family_id: string | null;
  matched_parent_id: string | null;
  matched_parent_ghl_contact_id: string | null;
  match_method: string | null;
  direct_ghl_contact_id: string | null;
  ghl_lookup_result: string | null;
  additional_notes: string | null;
  vol_additional: string | null;
  social_media: string | null;
  linkedin: string | null;
  facebook: string | null;
  school_notes: string | null;
  school_notes_updated_at: string | null;
  tags_json: string[] | null;
  gifts_json: DonorGift[] | null;
  narratives_json: string[] | null;
  campaigns_json: string[] | null;
}

interface RawCampaignRow {
  label: string;
  slug: string;
  gift_count: number;
  donor_count: number;
  total_amount: string;
}

interface RawTierRow {
  label: string;
  gift_count: number;
  total_amount: string;
}

interface RawUncodedRow {
  gift_count: number;
  total_amount: string;
}

export async function fetcher(
  school: SchoolContext,
  config: DonorDashboardConfig,
  searchParams?: WidgetSearchParams,
): Promise<DonorDashboardData> {
  const sp = searchParams ?? {};
  const startMonth = config.school_year_start_month || 7;
  const now = new Date();
  const cur = schoolYearWindow(now, startMonth);
  const prior = priorSchoolYearWindow(now, startMonth);

  // ---- Big roll-up: one row per donor with aggregates + tags + recent
  // gifts for the accordion. ----
  const { rows: rawRows } = await query<RawDonorRow>(
    `WITH gift_aggs AS (
       SELECT
         dp_donor_id,
         SUM(amount)::numeric AS total_amount,
         SUM(amount) FILTER (WHERE gift_date >= $2::date AND gift_date < $3::date)::numeric AS ytd_amount,
         SUM(amount) FILTER (WHERE gift_date >= $4::date AND gift_date < $5::date)::numeric AS ly_amount,
         COUNT(*)::int AS gift_count,
         MAX(gift_date)::text AS last_gift_date
       FROM dp_gifts
       WHERE school_id = $1
       GROUP BY dp_donor_id
     ),
     tag_aggs AS (
       SELECT dp_donor_id, ARRAY_AGG(tag ORDER BY tag) AS tags
       FROM donor_tags WHERE school_id = $1
       GROUP BY dp_donor_id
     ),
     gift_history AS (
       SELECT
         dp_donor_id,
         json_agg(
           json_build_object(
             'id', id,
             'dp_gift_id', dp_gift_id,
             'gift_date', gift_date,
             'amount', amount,
             'solicit_code', solicit_code,
             'solicit_code_descr', solicit_code_descr,
             'sub_solicit_code_descr', sub_solicit_code_descr,
             'narrative', narrative
           )
           ORDER BY gift_date DESC NULLS LAST, dp_gift_id DESC
         ) AS gifts
       FROM dp_gifts
       WHERE school_id = $1
       GROUP BY dp_donor_id
     ),
     -- Per-donor deduped narratives — many gifts repeat the same long
     -- note from the operator. ARRAY_AGG(DISTINCT) collapses repeats.
     donor_narratives AS (
       SELECT dp_donor_id,
              ARRAY_AGG(DISTINCT narrative) FILTER (WHERE narrative IS NOT NULL AND narrative <> '') AS narratives
         FROM dp_gifts
        WHERE school_id = $1
        GROUP BY dp_donor_id
     ),
     -- Per-donor campaign list — what campaigns have they supported?
     donor_campaigns AS (
       SELECT dp_donor_id,
              ARRAY_AGG(DISTINCT COALESCE(solicit_code_descr, solicit_code))
                FILTER (WHERE (solicit_code_descr IS NOT NULL AND solicit_code_descr <> '')
                            OR (solicit_code IS NOT NULL AND solicit_code <> '')) AS campaigns
         FROM dp_gifts
        WHERE school_id = $1
        GROUP BY dp_donor_id
     )
     SELECT
       d.id,
       d.dp_donor_id,
       d.first_name, d.last_name,
       d.email,
       d.mobile_phone, d.home_phone, d.business_phone,
       d.city, d.state,
       d.org_rec, d.inferred_segment,
       COALESCE(d.gift_total, ga.total_amount, 0) AS gift_total,
       COALESCE(ga.ytd_amount, 0) AS ytd_amount,
       COALESCE(ga.ly_amount, 0) AS ly_amount,
       COALESCE(ga.gift_count, 0) AS gift_count,
       ga.last_gift_date,
       d.matched_family_id,
       d.matched_parent_id,
       p.ghl_contact_id AS matched_parent_ghl_contact_id,
       d.match_method,
       d.ghl_contact_id AS direct_ghl_contact_id,
       d.ghl_contact_lookup_result AS ghl_lookup_result,
       d.additional_notes,
       d.vol_additional,
       d.social_media, d.linkedin, d.facebook,
       d.school_notes,
       d.school_notes_updated_at,
       ta.tags AS tags_json,
       gh.gifts AS gifts_json,
       dn.narratives AS narratives_json,
       dc.campaigns AS campaigns_json
     FROM dp_donors d
     LEFT JOIN gift_aggs ga ON ga.dp_donor_id = d.dp_donor_id
     LEFT JOIN tag_aggs ta ON ta.dp_donor_id = d.dp_donor_id
     LEFT JOIN gift_history gh ON gh.dp_donor_id = d.dp_donor_id
     LEFT JOIN donor_narratives dn ON dn.dp_donor_id = d.dp_donor_id
     LEFT JOIN donor_campaigns dc ON dc.dp_donor_id = d.dp_donor_id
     LEFT JOIN parents p ON p.id = d.matched_parent_id
     WHERE d.school_id = $1`,
    [school.schoolId, cur.startIso, cur.endIso, prior.startIso, prior.endIso],
  );

  // ---- Map raw → DonorRow ----
  const allDonors: DonorRow[] = rawRows.map((r) => {
    const firstName = (r.first_name ?? '').trim();
    const lastName = (r.last_name ?? '').trim();
    const full = `${firstName} ${lastName}`.trim() || '(no name)';
    const phone = r.mobile_phone || r.home_phone || r.business_phone || null;
    const tags = r.tags_json ?? [];
    const haystack = [
      full, r.email ?? '', r.city ?? '', r.state ?? '',
      r.inferred_segment ?? '', tags.join(' '),
      r.additional_notes ?? '',
    ].join(' ').toLowerCase();
    return {
      id: r.id,
      dp_donor_id: r.dp_donor_id,
      full_name: full,
      email: r.email,
      phone,
      city: r.city,
      state: r.state,
      org_rec: (r.org_rec === 'Y' ? 'Y' : r.org_rec === 'N' ? 'N' : null) as 'Y' | 'N' | null,
      inferred_segment: r.inferred_segment,
      tags,
      gift_total: Number(r.gift_total ?? 0),
      ytd_school_year: Number(r.ytd_amount ?? 0),
      last_school_year: Number(r.ly_amount ?? 0),
      gift_count: Number(r.gift_count ?? 0),
      last_gift_date: r.last_gift_date,
      matched_family_id: r.matched_family_id,
      matched_parent_id: r.matched_parent_id,
      matched_parent_ghl_contact_id: r.matched_parent_ghl_contact_id,
      match_method: r.match_method,
      // Direct GHL lookup wins (it's the actual donor's contact, not a
      // parent that happens to be the same person); fallback to the
      // matched parent's contact.
      best_ghl_contact_id: r.direct_ghl_contact_id || r.matched_parent_ghl_contact_id,
      ghl_lookup_result: r.ghl_lookup_result,
      additional_notes: r.additional_notes,
      vol_additional: r.vol_additional,
      social_media: r.social_media,
      linkedin: r.linkedin,
      facebook: r.facebook,
      school_notes: r.school_notes,
      school_notes_updated_at: r.school_notes_updated_at,
      narratives: r.narratives_json ?? [],
      campaigns: r.campaigns_json ?? [],
      gifts: r.gifts_json ?? [],
      search_haystack: haystack,
    };
  });

  // ---- Campaign + tier + uncoded breakdowns (one query each, parallel) ----
  const [{ rows: campaignRows }, { rows: tierRows }, { rows: uncodedRows }] = await Promise.all([
    query<RawCampaignRow>(
      `SELECT
         COALESCE(solicit_code_descr, solicit_code)                       AS label,
         COALESCE(solicit_code, solicit_code_descr)                       AS slug,
         COUNT(*)::int                                                     AS gift_count,
         COUNT(DISTINCT dp_donor_id)::int                                  AS donor_count,
         SUM(amount)::numeric                                              AS total_amount
       FROM dp_gifts
       WHERE school_id = $1
         AND (solicit_code IS NOT NULL OR solicit_code_descr IS NOT NULL)
       GROUP BY 1, 2
       ORDER BY total_amount DESC`,
      [school.schoolId],
    ),
    query<RawTierRow>(
      `SELECT
         sub_solicit_code_descr                                            AS label,
         COUNT(*)::int                                                     AS gift_count,
         SUM(amount)::numeric                                              AS total_amount
       FROM dp_gifts
       WHERE school_id = $1
         AND sub_solicit_code_descr IS NOT NULL
         AND sub_solicit_code_descr <> ''
       GROUP BY 1
       ORDER BY total_amount DESC`,
      [school.schoolId],
    ),
    query<RawUncodedRow>(
      `SELECT
         COUNT(*)::int       AS gift_count,
         SUM(amount)::numeric AS total_amount
       FROM dp_gifts
       WHERE school_id = $1
         AND (solicit_code IS NULL OR solicit_code = '')
         AND (solicit_code_descr IS NULL OR solicit_code_descr = '')`,
      [school.schoolId],
    ),
  ]);
  const campaignBreakdowns: CampaignBreakdown[] = campaignRows.map((r) => ({
    label: r.label,
    slug: r.slug,
    gift_count: r.gift_count,
    donor_count: r.donor_count,
    total_amount: Number(r.total_amount ?? 0),
  }));
  const tierBreakdowns: TierBreakdown[] = tierRows.map((r) => ({
    label: r.label,
    gift_count: r.gift_count,
    total_amount: Number(r.total_amount ?? 0),
  }));
  const uncodedGiftCount = uncodedRows[0]?.gift_count ?? 0;
  const uncodedGiftTotal = Number(uncodedRows[0]?.total_amount ?? 0);

  // ---- Stats ----
  let lifetimeRaised = 0, lifetimeGifts = 0, lifetimeDonors = 0;
  let ytdRaised = 0, ytdDonors = 0, ytdGifts = 0;
  let lyRaised = 0, lyDonors = 0;
  let majorDonors = 0, currentFamilyDonors = 0;
  for (const d of allDonors) {
    lifetimeRaised += d.gift_total;
    lifetimeGifts += d.gift_count;
    if (d.gift_count > 0) lifetimeDonors++;
    if (d.ytd_school_year > 0) {
      ytdRaised += d.ytd_school_year;
      ytdDonors++;
      if (d.ytd_school_year >= config.major_donor_threshold) majorDonors++;
    }
    if (d.last_school_year > 0) {
      lyRaised += d.last_school_year;
      lyDonors++;
    }
    if (d.inferred_segment === 'current_family') currentFamilyDonors++;
  }
  // ytdGifts requires counting gift rows in window. Re-aggregate from gifts arr.
  for (const d of allDonors) {
    if (d.ytd_school_year > 0) {
      for (const g of d.gifts) {
        if (!g.gift_date) continue;
        if (g.gift_date >= cur.startIso && g.gift_date < cur.endIso) ytdGifts++;
      }
    }
  }
  // Retention: of LY donors, how many also gave this YR
  let retainedCount = 0;
  for (const d of allDonors) {
    if (d.last_school_year > 0 && d.ytd_school_year > 0) retainedCount++;
  }
  const retentionPct = lyDonors > 0 ? Math.round((100 * retainedCount) / lyDonors) : 0;
  const ytdAvgGift = ytdGifts > 0 ? Math.round(ytdRaised / ytdGifts) : 0;

  // ---- Annual buckets ----
  const buckets: YearBucket[] = [];
  for (let i = config.years_of_history - 1; i >= 0; i--) {
    const offsetNow = new Date(now);
    offsetNow.setFullYear(now.getFullYear() - i);
    const win = schoolYearWindow(offsetNow, startMonth);
    buckets.push({
      label: win.label,
      start_iso: win.startIso,
      end_iso: win.endIso,
      total_amount: 0,
      gift_count: 0,
      donor_count: 0,
      new_donor_count: 0,
      retained_count: 0,
    });
  }
  // Per-donor first-gift-date map for new-donor counting
  const firstGiftYearByDonor = new Map<string, string>();
  for (const d of allDonors) {
    if (d.gifts.length === 0) continue;
    let first: string | null = null;
    for (const g of d.gifts) {
      if (!g.gift_date) continue;
      if (!first || g.gift_date < first) first = g.gift_date;
    }
    if (first) firstGiftYearByDonor.set(d.dp_donor_id, schoolYearLabelForDate(new Date(first + 'T00:00:00Z'), startMonth));
  }
  // Per-donor years-given set
  const yearsGivenByDonor = new Map<string, Set<string>>();
  for (const d of allDonors) {
    const ys = new Set<string>();
    for (const g of d.gifts) {
      if (!g.gift_date) continue;
      const date = new Date(g.gift_date + 'T00:00:00Z');
      const label = schoolYearLabelForDate(date, startMonth);
      ys.add(label);
    }
    yearsGivenByDonor.set(d.dp_donor_id, ys);
  }
  for (const bucket of buckets) {
    // donors who gave in this bucket
    const donorsThisYear = new Set<string>();
    for (const d of allDonors) {
      const ys = yearsGivenByDonor.get(d.dp_donor_id);
      if (ys && ys.has(bucket.label)) donorsThisYear.add(d.dp_donor_id);
    }
    bucket.donor_count = donorsThisYear.size;
    // total + count + new
    for (const d of allDonors) {
      if (!donorsThisYear.has(d.dp_donor_id)) continue;
      let amt = 0, cnt = 0;
      for (const g of d.gifts) {
        if (!g.gift_date) continue;
        if (g.gift_date >= bucket.start_iso && g.gift_date < bucket.end_iso) {
          amt += g.amount;
          cnt++;
        }
      }
      bucket.total_amount += amt;
      bucket.gift_count += cnt;
      const firstYr = firstGiftYearByDonor.get(d.dp_donor_id);
      if (firstYr === bucket.label) bucket.new_donor_count++;
    }
  }
  // Retained = donors who gave in this year AND the prior bucket
  for (let i = 1; i < buckets.length; i++) {
    const prevLabel = buckets[i - 1].label;
    const curLabel = buckets[i].label;
    let retained = 0;
    for (const ys of yearsGivenByDonor.values()) {
      if (ys.has(prevLabel) && ys.has(curLabel)) retained++;
    }
    buckets[i].retained_count = retained;
  }

  // ---- Segment breakdowns ----
  function bucketize(filterFn: (d: DonorRow) => boolean): SegmentBreakdown['donor_count'] extends number ? Omit<SegmentBreakdown, 'segment'> : never {
    let dc = 0, tytd = 0, tlife = 0;
    for (const d of allDonors) {
      if (!filterFn(d)) continue;
      dc++;
      tytd += d.ytd_school_year;
      tlife += d.gift_total;
    }
    return { donor_count: dc, total_ytd: tytd, total_lifetime: tlife };
  }
  const segmentBreakdowns: SegmentBreakdown[] = [
    { segment: 'business', ...bucketize((d) => d.inferred_segment === 'business') },
    { segment: 'current_family', ...bucketize((d) => d.inferred_segment === 'current_family') },
    { segment: 'alumni_family', ...bucketize((d) => d.inferred_segment === 'alumni_family') },
    { segment: 'individual', ...bucketize((d) => d.inferred_segment === 'individual') },
  ];
  // All distinct tag breakdowns
  const allTagsSet = new Set<string>();
  for (const d of allDonors) for (const t of d.tags) allTagsSet.add(t);
  const allTags = [...allTagsSet].sort();
  for (const tag of allTags) {
    segmentBreakdowns.push({
      segment: `tag:${tag}`,
      ...bucketize((d) => d.tags.includes(tag)),
    });
  }

  // ---- Top donors ----
  const topDonors = [...allDonors]
    .filter((d) => d.gift_total > 0)
    .sort((a, b) => b.gift_total - a.gift_total)
    .slice(0, config.top_donors_limit);

  // ---- Directory filter / sort / paginate ----
  const search = (sp.q ?? '').trim().toLowerCase();
  const segmentFilter = (sp.segment ?? '').trim();
  const tagFilter = (sp.tag ?? '').trim();
  const cityFilter = (sp.city ?? '').trim();
  const stateFilter = (sp.state ?? '').trim();
  // 'ytd' = gave this school year (any amount)
  // 'major' = gave >= major_donor_threshold this school year
  // 'mid' = gave between mid and major thresholds this school year
  // 'grass' = gave > 0 but below mid_donor_threshold this school year
  // 'lapsed' = no gift in 18 months
  // 'major_lifetime' = lifetime giving >= major_donor_threshold
  const givingFilter = (sp.giving ?? '').trim();
  const major = config.major_donor_threshold;
  const mid = config.mid_donor_threshold;

  // Campaign filter: matches against any of the donor's gifts'
  // solicit_code OR solicit_code_descr (case-insensitive). Lets the
  // operator click a campaign tile to see "everyone who supported
  // DREAM 2024."
  const campaignFilter = (sp.campaign ?? '').trim().toLowerCase();
  const filtered = allDonors.filter((d) => {
    if (segmentFilter && d.inferred_segment !== segmentFilter) return false;
    if (tagFilter && !d.tags.includes(tagFilter)) return false;
    if (cityFilter && (d.city ?? '') !== cityFilter) return false;
    if (stateFilter && (d.state ?? '') !== stateFilter) return false;
    if (campaignFilter) {
      const matched = d.gifts.some((g) =>
        (g.solicit_code ?? '').toLowerCase() === campaignFilter
        || (g.solicit_code_descr ?? '').toLowerCase() === campaignFilter
      );
      if (!matched) return false;
    }
    if (givingFilter === 'ytd' && d.ytd_school_year <= 0) return false;
    if (givingFilter === 'major' && d.ytd_school_year < major) return false;
    if (givingFilter === 'mid' &&
        !(d.ytd_school_year >= mid && d.ytd_school_year < major)) return false;
    if (givingFilter === 'grass' &&
        !(d.ytd_school_year > 0 && d.ytd_school_year < mid)) return false;
    if (givingFilter === 'major_lifetime' && d.gift_total < major) return false;
    if (givingFilter === 'lapsed') {
      // No gift in the last 18 months
      if (!d.last_gift_date) return false;
      const cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 18);
      if (new Date(d.last_gift_date) >= cutoff) return false;
    }
    if (search && !d.search_haystack.includes(search)) return false;
    return true;
  });

  // Sort. If the operator hasn't pinned a direction, default to the
  // intuitive one per key: ascending for name (A-Z), descending for
  // money/date columns (biggest / most recent first). Lets the
  // "Sort: Name (A-Z)" dropdown option do what it says without forcing
  // the operator to also toggle direction.
  const sortKey = (sp.sort ?? 'lifetime') as 'lifetime' | 'ytd' | 'name' | 'last_gift';
  let dir: 1 | -1;
  if (sp.dir === 'asc') dir = 1;
  else if (sp.dir === 'desc') dir = -1;
  else dir = sortKey === 'name' ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'lifetime':  cmp = a.gift_total - b.gift_total; break;
      case 'ytd':       cmp = a.ytd_school_year - b.ytd_school_year; break;
      case 'name':      cmp = a.full_name.localeCompare(b.full_name); break;
      case 'last_gift': cmp = (a.last_gift_date ?? '').localeCompare(b.last_gift_date ?? ''); break;
    }
    return cmp * dir;
  });

  const perPage = Math.max(10, Math.min(500, Number(sp.per_page) || 50));
  const page = Math.max(1, Number(sp.page) || 1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  // ---- Filter option lists ----
  const statesSet = new Set<string>();
  const citiesSet = new Set<string>();
  for (const d of allDonors) {
    if (d.state) statesSet.add(d.state);
    if (d.city) citiesSet.add(d.city);
  }

  return {
    stats: {
      lifetime_raised: lifetimeRaised,
      lifetime_gifts: lifetimeGifts,
      lifetime_donors: lifetimeDonors,
      ytd_raised: ytdRaised,
      ytd_donors: ytdDonors,
      ytd_gifts: ytdGifts,
      ytd_avg_gift: ytdAvgGift,
      ly_raised: lyRaised,
      ly_donors: lyDonors,
      retention_pct: retentionPct,
      major_donor_count: majorDonors,
      current_family_donors: currentFamilyDonors,
    },
    current_school_year_label: cur.label,
    segment_breakdowns: segmentBreakdowns,
    campaign_breakdowns: campaignBreakdowns,
    tier_breakdowns: tierBreakdowns,
    uncoded_gift_count: uncodedGiftCount,
    uncoded_gift_total: uncodedGiftTotal,
    annual_buckets: buckets,
    top_donors: topDonors,
    directory_rows: pageRows,
    all_tags: allTags,
    options: {
      states: [...statesSet].sort(),
      cities: [...citiesSet].sort(),
    },
    page: safePage,
    per_page: perPage,
    page_count: pageCount,
    total_directory: allDonors.length,
    filtered_count: filtered.length,
  };
}
