// HelpCallout — collapsible "How this works" inline guide.
//
// Drop into any admin page to give first-time operators numbered steps
// for the demo / day-to-day flow. Defaults to expanded so the user sees
// the instructions on first paint; toggleable.
//
// Server-rendered shell + minimal client island for the toggle so it
// stays cheap inside RSC trees.

'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Lightbulb } from 'lucide-react';

export function HelpCallout({
  title,
  steps,
  tone = 'blue',
  defaultOpen = true,
}: {
  title: string;
  steps: React.ReactNode[];
  tone?: 'blue' | 'amber' | 'emerald';
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const palette = tone === 'amber'
    ? { border: 'border-amber-300',   bg: 'bg-amber-50',   fg: 'text-amber-900',   icon: 'text-amber-600' }
    : tone === 'emerald'
    ? { border: 'border-emerald-300', bg: 'bg-emerald-50', fg: 'text-emerald-900', icon: 'text-emerald-600' }
    : { border: 'border-blue-300',    bg: 'bg-blue-50',    fg: 'text-blue-900',    icon: 'text-blue-600' };

  return (
    <div className={`rounded-lg border ${palette.border} ${palette.bg} px-4 py-3`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 ${palette.fg} text-left`}
      >
        <Lightbulb className={`h-4 w-4 ${palette.icon} shrink-0`} />
        <span className="text-sm font-semibold flex-1">{title}</span>
        {open ? <ChevronDown className="h-4 w-4 opacity-60" /> : <ChevronRight className="h-4 w-4 opacity-60" />}
      </button>
      {open ? (
        <ol className={`mt-2 ml-6 list-decimal space-y-1 text-sm ${palette.fg}`}>
          {steps.map((s, i) => (
            <li key={i} className="leading-relaxed">{s}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
