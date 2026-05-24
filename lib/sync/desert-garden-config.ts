// Desert Garden Montessori's GHL custom-field schema. Pulled from the
// bespoke desert-garden-admin app (lib/desert-garden-config.ts) so the
// platform sees the exact same data as the bespoke dashboard.
//
// Field-naming convention: snake_case keys, where:
//   - Slot 1 student fields are bare:  "student_first_name"
//   - Slot 2-4 are slot-prefixed:      "student_2_first_name"
// One contact = one family. Up to 4 student slots per contact.

export const MAX_STUDENT_SLOTS = 4;

// Default academic year used when GHL doesn't store one explicitly. Update
// this every July/August. Eventually we'll derive from the
// current_year_enrollment_start_date but a constant is fine for v1.
export const DEFAULT_ACADEMIC_YEAR = '2026-27';

export const FAMILY_FIELDS = {
  householdId: 'household_id',
  language: 'language',
  activeStatus: 'active_inactive',
  parentsCombined: 'parents_combined',
  householdPhone: 'household_phone',
} as const;

export const PARENT2_FIELDS = {
  firstName: 'parent_2_first_name',
  lastName: 'parent_2_last_name',
  email: 'parent_2_email',
  phone: 'parent_2_phone',
  homePhone: 'parent_2_home_phone',
} as const;

export const STUDENT_FIELDS = {
  firstName: 'first_name',
  lastName: 'last_name',
  preferredName: 'preferred_name',
  birthDate: 'birth_date',
  gender: 'gender',
  gradeLevel: 'grade_level',
  program: 'program',
  homeroom: 'homeroom',
  enrollmentStatus: 'enrollment_status',
  initialStartDate: 'initial_start_date',
  currentYearStartDate: 'current_year_enrollment_start_date',
  iep: 'iep',
  fivelOFourPlan: '504_plan',
  dailySchedule: 'daily_schedule',
  leadTeacher: 'lead_teacher',
  allergy: 'allergy',

  // Financial fields the Finance widget reads
  tuitionFee: 'tuition_fee',
  extendedDayFee: 'extended_day_fee',
  lunchFee: 'lunch_fee',
  adminFee: 'admin_fee',
  enrollmentFee: 'enrollment_fee',
  lateFee: 'late_fee',
  totalAmount: 'total_amount',
  paymentPlan: 'payment_plan',
  organicLunch: 'organic_lunch',

  // Discounts
  annualDiscount: 'annual_discount',
  employeeDiscount: 'employee_discount',
  siblingDiscount: 'sibling_discount',
  financialAid: 'financial_aid',

  // Service 1 (Enrichment) — name + bill amount
  service1: 'service_1',
  service1Bill: 'service_1_bill_amount',
  // Service 2 (Sports)
  service2: 'service_2',
  service2Bill: 'service_2_bill_amount',

  // Hearing & Vision
  hearingVisionFall: 'hearing_and_vision_fall',
  hearingVisionSpring: 'hearing_and_vision_spring',

  // Summer
  summerProgram: 'summer_program',
  summerSchedule: 'summer_schedule',
  summerClassroom: 'summer_classroom',
  summerFormReceivedDate: 'summer_form_received_date',
  summerMonthJune: 'summer_month_june',
  summerMonthJuly: 'summer_month_july',
  summerLunch: 'summer_lunch',

  // SST
  sstStatus: 'sst_status',
  sstStartDate: 'sst_start_date',
  sstFee: 'sst_fee',

  // ESA / STO (AZ programs)
  esaRecipient: 'esa_recipient',
  esaAmount: 'esa_amount',
  stoRecipient: 'sto_recipient',
  stoType: 'sto_type',
  stoAmount: 'sto_amount',

  // Employee + referrals
  employeeKid: 'employee_kid',
  referralCredit: 'referral_credit',
  referredBy: 'referred_by',
} as const;

// Slot 1: "student_<base>"  |  Slot 2-4: "student_<slot>_<base>"
export function studentFieldKey(slot: number, baseKey: string): string {
  const prefix = slot === 1 ? 'student' : `student_${slot}`;
  return `${prefix}_${baseKey}`;
}
