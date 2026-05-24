'use client';

// recharts is client-only (it uses browser APIs). We isolate the chart in
// a small client component so the widget's outer component can stay
// server-rendered.

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GradeBar } from './fetcher';

export function EnrollmentBars({ bars }: { bars: GradeBar[] }) {
  return (
    <div className="w-full" style={{ height: 320 }}>
      <ResponsiveContainer>
        <BarChart data={bars} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="grade_label" tick={{ fontSize: 11 }} interval={0} angle={-15} textAnchor="end" height={60} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="enrolled" stackId="a" fill="#10b981" name="Enrolled" />
          <Bar dataKey="in_pipeline" stackId="a" fill="#f59e0b" name="In pipeline" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
