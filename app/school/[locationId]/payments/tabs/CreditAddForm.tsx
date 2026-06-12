'use client';

// Add-a-credit form with a family → student cascade. Schools attribute
// credits to a specific student (their books run on the student record);
// leaving the student select empty keeps it a whole-family credit.

import { useState } from 'react';

interface Option { id: string; label: string }
interface Member { id: string; name: string }

export function CreditAddForm({
  schoolId, returnTo, familyOptions, studentsByFamily,
}: {
  schoolId: string;
  returnTo: string;
  familyOptions: Option[];
  studentsByFamily: Record<string, Member[]>;
}) {
  const [familyId, setFamilyId] = useState('');
  const students = familyId ? (studentsByFamily[familyId] ?? []) : [];

  return (
    <form action="/api/school/family-credits" method="POST" className="space-y-2">
      <input type="hidden" name="action" value="add" />
      <input type="hidden" name="school_id" value={schoolId} />
      <input type="hidden" name="return_to" value={returnTo} />
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">Add a credit</div>
      <select
        name="family_id" required value={familyId}
        onChange={(e) => setFamilyId(e.target.value)}
        className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
      >
        <option value="">— pick a family —</option>
        {familyOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      {familyId ? (
        <select
          name="student_id" key={`st-${familyId}`}
          defaultValue={students.length === 1 ? students[0].id : ''}
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">Whole family (no specific student)</option>
          {students.map((s) => <option key={s.id} value={s.id}>Attribute to {s.name}</option>)}
        </select>
      ) : null}
      <div className="flex gap-2">
        <input type="number" name="amount" min="0.01" step="0.01" required placeholder="Amount ($)"
          className="w-32 rounded border border-slate-300 px-2 py-1.5 text-sm" />
        <input type="text" name="reason" placeholder="Reason (e.g. withdrawal proration, goodwill)"
          className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm" />
      </div>
      <button type="submit" className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800">
        Add credit
      </button>
      <p className="text-[11px] text-slate-500">
        Credits sit on the family&apos;s account (optionally earmarked for a student). Apply them from
        any open invoice&apos;s detail page — student-earmarked credits apply to that student&apos;s
        invoices first, and leftover credit stays for next time.
      </p>
    </form>
  );
}
