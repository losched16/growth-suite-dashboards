'use client';

// Filter-form wrapper that auto-submits when the user changes a control.
//
// UX rule (matches the bespoke desert-garden-admin pattern that operators
// love): operator should never have to click "Apply" — selecting a filter
// applies it immediately, typing in the search box applies after a short
// debounce. The Apply button stays in the DOM for accessibility / no-JS
// fallback but becomes redundant.
//
// Behavior:
//   - <select> change            → submit immediately
//   - <input type="search|text"> → submit after 350ms debounce
//   - everything else            → submit immediately
//
// Uses native <form> GET semantics so this stays compatible with the
// existing URL-state-driven server components — we just trigger
// `form.requestSubmit()` programmatically instead of waiting for the
// operator to click submit. Server re-renders with the new params.

import { useEffect, useRef } from 'react';

const DEBOUNCE_MS = 350;

interface Props {
  className?: string;
  method?: 'GET' | 'POST';
  children: React.ReactNode;
}

export function AutoSubmitForm({ className, method = 'GET', children }: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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

    function scheduleDebounced() {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(submit, DEBOUNCE_MS);
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
      if (target instanceof HTMLInputElement) {
        if (target.type === 'checkbox' || target.type === 'radio') {
          submit();
          return;
        }
        // text / search / number / etc → debounce
        scheduleDebounced();
        return;
      }
      // textarea etc — debounce as well
      scheduleDebounced();
    }

    // 'input' fires on every keystroke; 'change' fires on commit for selects.
    form.addEventListener('input', onChange);
    form.addEventListener('change', onChange);
    return () => {
      form.removeEventListener('input', onChange);
      form.removeEventListener('change', onChange);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <form ref={formRef} method={method} className={className}>
      {children}
    </form>
  );
}
