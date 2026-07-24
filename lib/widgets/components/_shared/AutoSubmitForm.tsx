'use client';

// Filter-form wrapper.
//
// Behavior:
//   - <select> change            → submit immediately
//   - checkbox / radio change    → submit immediately
//   - <input type="search|text"> → submit on ENTER only. The old 350ms
//     debounce reloaded the server-rendered page mid-word — operators
//     typing a family name lost focus and their place unless they typed
//     fast enough (Clint, 2026-07-24). Slow typing must never search.
//   - The Apply button stays in the DOM for accessibility / no-JS
//     fallback but becomes redundant.
//
// Every submit (programmatic or Enter) stashes the scroll position in
// sessionStorage and restores it after the reload, so applying a filter
// keeps the operator where they were in a long table instead of dumping
// them back at the top.
//
// Uses native <form> GET semantics so this stays compatible with the
// existing URL-state-driven server components — we just trigger
// `form.requestSubmit()` programmatically instead of waiting for the
// operator to click submit. Server re-renders with the new params.

import { useEffect, useRef } from 'react';

interface Props {
  className?: string;
  method?: 'GET' | 'POST';
  children: React.ReactNode;
}

const scrollKey = () => `gs-filter-scroll:${location.pathname}`;

export function AutoSubmitForm({ className, method = 'GET', children }: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    // Restore the scroll position stashed by the previous filter submit on
    // this page. The browser clamps to the new (possibly shorter) height.
    try {
      const stored = sessionStorage.getItem(scrollKey());
      if (stored !== null) {
        sessionStorage.removeItem(scrollKey());
        const y = Number(stored);
        if (Number.isFinite(y) && y > 0) window.scrollTo(0, y);
      }
    } catch { /* sessionStorage unavailable in some embed contexts */ }

    const form = formRef.current;
    if (!form) return;

    function submit() {
      // requestSubmit() respects validity + submit handlers; falls back to
      // submit() in older browsers. We catch errors silently because
      // some browsers throw when called during a pending submission.
      try {
        form?.requestSubmit?.() ?? form?.submit();
      } catch {
        form?.submit();
      }
    }

    function onChange(e: Event) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Ignore hidden inputs (used for state preservation) — they change
      // synthetically and would cause submit loops.
      if (target instanceof HTMLInputElement && target.type === 'hidden') return;
      if (target instanceof HTMLSelectElement) {
        submit();
        return;
      }
      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
        submit();
      }
      // Text / search / textarea: no auto-submit — Enter handles it.
    }

    // Enter in a text/search input submits explicitly. (Implicit form
    // submission is unreliable when a form has several text fields and
    // its only submit button is inside <noscript>.)
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'search' || t.type === 'number')) {
        e.preventDefault();
        submit();
      }
    }

    function onSubmit() {
      try { sessionStorage.setItem(scrollKey(), String(window.scrollY)); } catch { /* ignore */ }
    }

    form.addEventListener('change', onChange);
    form.addEventListener('keydown', onKeydown);
    form.addEventListener('submit', onSubmit);
    return () => {
      form.removeEventListener('change', onChange);
      form.removeEventListener('keydown', onKeydown);
      form.removeEventListener('submit', onSubmit);
    };
  }, []);

  return (
    <form ref={formRef} method={method} className={className}>
      {children}
    </form>
  );
}
