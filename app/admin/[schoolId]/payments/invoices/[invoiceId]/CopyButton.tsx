'use client';

import { useState } from 'react';
import { Copy, CheckCircle2 } from 'lucide-react';

export function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silently fail
    }
  }
  return (
    <button
      type="button"
      onClick={doCopy}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
      title={url}
    >
      {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied!' : 'Copy parent-pay link'}
    </button>
  );
}
