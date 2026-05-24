import Link from 'next/link';
import {
  FileText, Users, GraduationCap, TrendingUp, Megaphone, CreditCard, BarChart3,
  type LucideIcon,
} from 'lucide-react';
import type { SchoolDashboardRow } from '@/lib/dashboards/types';

const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Users, GraduationCap, TrendingUp, Megaphone, CreditCard, BarChart3,
};

interface Props {
  schoolName: string;
  locationId: string;
  dashboards: SchoolDashboardRow[];
  activeSlug: string | null;
  iconBySlug: Record<string, string>;
}

export function DashboardNav({ schoolName, locationId, dashboards, activeSlug, iconBySlug }: Props) {
  return (
    <aside className="w-56 shrink-0 border-r border-gray-200 bg-white py-3">
      <div className="px-4 pb-3 mb-2 border-b border-gray-100">
        <div className="text-sm font-semibold text-emerald-700 truncate">{schoolName}</div>
        <div className="text-[10px] text-gray-400 mt-0.5 font-mono truncate">{locationId}</div>
      </div>
      <nav className="px-2 space-y-0.5">
        {dashboards.map((d) => {
          const iconName = iconBySlug[d.dashboard_slug];
          const Icon = iconName && ICON_MAP[iconName] ? ICON_MAP[iconName] : FileText;
          const active = d.dashboard_slug === activeSlug;
          return (
            <Link
              key={d.id}
              href={`/school/${locationId}/${d.dashboard_slug}`}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                active
                  ? 'bg-emerald-50 text-emerald-800 font-medium'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{d.display_name}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
