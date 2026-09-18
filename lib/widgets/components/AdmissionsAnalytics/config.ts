import type { ConfigSchema } from '@/lib/widgets/types';

// A way of recognising something on a contact from the CRM mirror.
// Any one matching clause is enough (OR). Tag entries ending in '*' match
// by prefix ("open house - *"). Tags compare case-insensitively.
export interface MatchRule {
  tags_any?: string[];
  tags_all?: string[];
  stages?: string[];                      // opportunity stage names
  field?: { key: string; values?: string[] }; // non-empty, or one of values
}

// One step of the admissions funnel. Milestone KEYS carry meaning for the
// derived sections: inquiry, open_house, application, completed, offer,
// accepted, enrolled. Unknown keys still render in the funnel.
export interface MilestoneRule extends MatchRule {
  key: string;
  label: string;
  always?: boolean;        // every applicant/lead counts (e.g. inquiry)
  optional?: boolean;      // side path (open house): not implied by later
                           // milestones, skipped in stage-to-stage conversion
  date_field?: string;     // CRM date field recording when it was reached
  documents_complete?: boolean; // reached when every required document
                                // (config.documents, incl. only_if) is in
}

export interface DocRequirement {
  label: string;
  tags_any: string[];
  only_if?: { field: string; equals: string }; // e.g. IEP doc only when IEP = Yes
}

export interface PriorCycle {
  cycle: string;           // '2025-26'
  [milestoneKey: string]: string | number;
}

export interface AdmissionsAnalyticsConfig {
  milestones: MilestoneRule[];

  // Who is the applicant — student name fields on the contact.
  student_first_field: string;
  student_last_field: string;

  // Contacts that are not families (teacher recommenders, staff, tests).
  exclude_tags: string[];
  exclude_email_domains: string[];
  exclude_emails: string[];
  require_contact_name: boolean;   // drop contacts with no first/last name

  open_house_event_field?: string;
  open_house_event_tag_prefix?: string;
  open_house_attended?: MatchRule;
  open_house_no_show?: MatchRule;

  zip_field?: string;
  city_field?: string;
  current_school_field?: string;
  current_school_aliases?: Record<string, string>;
  referral_fields?: string[];      // first non-empty wins
  current_grade_field?: string;
  applying_grade_field?: string;
  income_field?: string;
  household_size_field?: string;
  languages_field?: string;
  language_aliases?: Record<string, string>;

  documents?: DocRequirement[];

  cycle_field?: string;            // e.g. year_of_entry ("2026" → 2026-27)
  cycle_start_month: number;       // 1-12; contacts added from this month
                                   // on belong to the NEXT fall's entry cycle
  default_cycle?: string;
  prior_cycles?: PriorCycle[];     // board-reported totals before the CRM
}

export const admissionsAnalyticsDefaults: AdmissionsAnalyticsConfig = {
  milestones: [
    { key: 'inquiry', label: 'Inquiries', always: true },
    { key: 'open_house', label: 'Open House registrations', optional: true, tags_any: ['open house*'] },
    { key: 'application', label: 'Applications', tags_any: ['application submitted'] },
    { key: 'completed', label: 'Completed applications', tags_any: ['application complete'] },
    { key: 'offer', label: 'Offers', stages: ['Offer Made', 'Offer Accepted', 'Enrolled'] },
    { key: 'accepted', label: 'Acceptances', stages: ['Offer Accepted', 'Enrolled'] },
    { key: 'enrolled', label: 'Enrollments', stages: ['Enrolled'] },
  ],
  student_first_field: 'student_first_name',
  student_last_field: 'student_last_name',
  exclude_tags: [],
  exclude_email_domains: [],
  exclude_emails: [],
  require_contact_name: true,
  cycle_start_month: 8,
};

export const admissionsAnalyticsSchema: ConfigSchema = {
  fields: [
    { type: 'text', key: 'default_cycle', label: 'Default admissions cycle', placeholder: '2026-27',
      help: 'Entry school year shown first. Blank = the most recent cycle with applications.' },
    { type: 'number', key: 'cycle_start_month', label: 'Cycle starts in month (1-12)', min: 1, max: 12,
      help: 'Families who first reach you from this month on count toward the next fall’s entry cycle.' },
  ],
};
