'use client';

import { Funnel, FunnelChart, LabelList, ResponsiveContainer, Tooltip } from 'recharts';
import type { FunnelStage } from './fetcher';

// Each stage gets a slightly cooler color as we go down the funnel.
const COLORS = ['#fbbf24', '#0ea5e9', '#8b5cf6', '#22d3ee', '#10b981'];

export function FunnelView({ stages }: { stages: FunnelStage[] }) {
  // recharts Funnel expects { name, value, fill } per stage.
  const data = stages.map((s, i) => ({
    name: s.label,
    value: Math.max(s.count, 1), // avoid 0-height segments
    actualCount: s.count,
    pct: s.pct_of_top,
    fill: COLORS[i % COLORS.length],
  }));

  return (
    <div className="w-full" style={{ height: 360 }}>
      <ResponsiveContainer>
        <FunnelChart>
          <Tooltip
            formatter={(_v, _n, ctx) => {
              const p = ctx?.payload as { actualCount?: number; pct?: number } | undefined;
              return [`${p?.actualCount ?? 0} (${p?.pct ?? 0}% of top)`, ''];
            }}
          />
          <Funnel dataKey="value" data={data} isAnimationActive={false}>
            <LabelList
              position="right"
              fill="#374151"
              stroke="none"
              fontSize={12}
              dataKey={(entry: { name: string; actualCount: number }) =>
                `${entry.name} — ${entry.actualCount}`
              }
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  );
}
