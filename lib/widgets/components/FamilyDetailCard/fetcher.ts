import type { SchoolContext } from '@/lib/widgets/types';
import type { FamilyDetailCardConfig } from './config';
import { familyGraph } from '@/lib/family-graph/client';

export interface ParentOut {
  id: string;
  name: string;
  email: string;
  phone: string;
  is_primary: boolean;
  ghl_contact_id: string | null;
}

export interface FamilyDetailCardData {
  family_id: string | null;
  display_name: string;
  status: string;
  parents: ParentOut[];
  student_count: number;
  notes: string;
}

export async function fetcher(
  _school: SchoolContext,
  config: FamilyDetailCardConfig
): Promise<FamilyDetailCardData> {
  const familyId = config.family_id;
  if (!familyId) {
    return {
      family_id: null,
      display_name: '',
      status: '',
      parents: [],
      student_count: 0,
      notes: '',
    };
  }
  const detail = await familyGraph.families.get(familyId);
  return {
    family_id: detail.family.id,
    display_name: detail.family.display_name ?? '(unnamed family)',
    status: detail.family.status,
    parents: detail.parents.map((p) => ({
      id: p.id,
      name: `${p.first_name} ${p.last_name}`.trim(),
      email: p.email ?? '',
      phone: p.phone ?? '',
      is_primary: p.is_primary,
      ghl_contact_id: p.ghl_contact_id,
    })),
    student_count: detail.students.length,
    notes: (detail.family as { notes?: string | null }).notes ?? '',
  };
}
