// Applications card — a shortcut to the application (survey) submissions
// so the office can open + print applications without digging through each
// contact record. Shows how many applications are on file and links
// straight over to the submissions view.
//
// The applications themselves are a GHL survey; the printable submissions
// live in GHL's submissions area. We deep-link there (configurable URL)
// and count applications from our synced roster (prospective families).

import { query } from '@/lib/db';
import type { WidgetDefinition, SchoolContext, ConfigSchema } from '@/lib/widgets/types';
import { crmAppBase } from '@/lib/ghl/contact-url';
import { FileText, ArrowUpRight, Inbox } from 'lucide-react';

export interface ApplicationsCardConfig {
  // Full URL to the survey/application submissions view. Leave blank to
  // default to this location's form-builder. Set it to the exact
  // submissions URL (copy from the browser) for a one-click landing.
  submissions_url?: string;
  heading?: string;
  description?: string;
}

interface Data {
  applications: number;
  families: number;
  url: string;
  heading: string;
  description: string;
}

async function fetcher(school: SchoolContext, config: ApplicationsCardConfig): Promise<Data> {
  // Count prospective (application-stage) students + their families as a
  // proxy for "applications received". One application ≈ one family.
  const { rows } = await query<{ apps: string; fams: string }>(
    `SELECT COUNT(*)::text AS apps,
            COUNT(DISTINCT family_id)::text AS fams
       FROM students
      WHERE school_id = $1 AND status = 'active'
        AND metadata->>'prospective' = 'true'`,
    [school.schoolId],
  );
  const url = (config?.submissions_url || '').trim()
    || `${crmAppBase()}/v2/location/${school.locationId}/form-builder`;
  return {
    applications: Number(rows[0]?.apps ?? 0),
    families: Number(rows[0]?.fams ?? 0),
    url,
    heading: config?.heading || 'Applications',
    description: config?.description
      || 'Open the submissions view to read, download, or print any application.',
  };
}

function Component({ data }: { school: SchoolContext; config: ApplicationsCardConfig; data: Data }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 max-w-2xl">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-blue-50 p-3 shrink-0">
          <FileText className="h-6 w-6 text-blue-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">{data.heading}</h2>
          <p className="text-sm text-slate-500 mt-0.5">{data.description}</p>

          <div className="mt-4 flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Inbox className="h-5 w-5 text-slate-400" />
              <div>
                <div className="text-2xl font-bold text-slate-900 leading-none tabular-nums">{data.applications}</div>
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">applications</div>
              </div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900 leading-none tabular-nums">{data.families}</div>
              <div className="text-[11px] text-slate-500 uppercase tracking-wide">families</div>
            </div>
          </div>

          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            View &amp; print applications <ArrowUpRight className="h-4 w-4" />
          </a>
          <p className="text-[11px] text-slate-400 mt-2">
            Opens your submissions view in a new tab. From there, click an application to download or print it.
          </p>
        </div>
      </div>
    </div>
  );
}

const schema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'submissions_url', label: 'Submissions URL (blank = this location’s form builder)', placeholder: 'https://app.mygrowthsuite.com/v2/location/.../form-builder' },
    { type: 'text', key: 'heading', label: 'Heading', placeholder: 'Applications' },
    { type: 'text', key: 'description', label: 'Description' },
  ],
};

export const ApplicationsCard: WidgetDefinition<ApplicationsCardConfig, Data> = {
  id: 'applications_card',
  display_name: 'Applications',
  description: 'Shortcut card to the application submissions — count of applications on file + a button to view/print them.',
  category: 'admissions',
  default_config: {},
  config_schema: schema,
  default_size: { w: 6, h: 4 },
  Component,
  dataFetcher: fetcher,
  searchParamsAffectFetch: false,
};
