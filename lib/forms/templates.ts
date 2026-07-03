// Generic portal-form starter templates — written from scratch for ANY school
// (no school's real form data). Creating from a template makes a DRAFT
// (is_active=false) the school then edits in the form builder and publishes.
//
// Conventions:
//   - signature_typed (typed legal name + auto-stamped date), never canvas
//   - per_student templates prefill the student's name from the record
//   - the emergency/medical template prefills from health.* so submissions
//     round-trip into student_health_profiles (platform behavior)

export interface FormTemplate {
  key: string;
  title: string;
  description: string;
  category: string;          // registration | medical | permission | trip | release
  per_student: boolean;
  field_schema: Array<Record<string, unknown>>;
}

const ack = (key: string, label: string) => ({ type: 'checkbox', key, label, required: true });
const sig = () => ([
  { type: 'section', label: 'Signature' },
  {
    type: 'signature_typed', key: 'signature', required: true,
    label: 'Type your full legal name to sign:',
    acknowledgment: 'By typing my name below, I am signing this form electronically and agree it has the same legal effect as a handwritten signature.',
  },
]);

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    key: 'pickup-authorization',
    title: 'Authorization to Pick Up',
    description: 'Parents list the people authorized to pick up their child, with contact info and relationship.',
    category: 'permission',
    per_student: true,
    field_schema: [
      { type: 'paragraph', text: 'Please list the adults (18+) authorized to pick up your child. School staff may ask for photo ID at pickup.' },
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'section', label: 'Authorized person 1' },
      { type: 'text', key: 'pickup1_name', label: 'Full name', required: true },
      { type: 'text', key: 'pickup1_relationship', label: 'Relationship to the child', required: true },
      { type: 'tel', key: 'pickup1_phone', label: 'Phone', required: true },
      { type: 'section', label: 'Authorized person 2 (optional)' },
      { type: 'text', key: 'pickup2_name', label: 'Full name' },
      { type: 'text', key: 'pickup2_relationship', label: 'Relationship to the child' },
      { type: 'tel', key: 'pickup2_phone', label: 'Phone' },
      { type: 'section', label: 'Authorized person 3 (optional)' },
      { type: 'text', key: 'pickup3_name', label: 'Full name' },
      { type: 'text', key: 'pickup3_relationship', label: 'Relationship to the child' },
      { type: 'tel', key: 'pickup3_phone', label: 'Phone' },
      { type: 'textarea', key: 'pickup_notes', label: 'Anyone NOT authorized to pick up, or other notes (optional)' },
      ...sig(),
    ],
  },
  {
    key: 'medication-consent',
    title: 'Medication Administration Consent',
    description: 'Consent for staff to administer a medication, with dosage, schedule, and prescriber details.',
    category: 'medical',
    per_student: true,
    field_schema: [
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'section', label: 'Medication' },
      { type: 'text', key: 'medication_name', label: 'Medication name', required: true },
      { type: 'text', key: 'dosage', label: 'Dosage (e.g. 5 ml, 1 tablet)', required: true },
      { type: 'text', key: 'administration_times', label: 'When should it be given?', required: true, placeholder: 'e.g. 12:00 PM with lunch' },
      { type: 'date', key: 'start_date', label: 'Start date', required: true },
      { type: 'date', key: 'end_date', label: 'End date', required: true },
      { type: 'select', key: 'medication_type', label: 'Type', required: true, options: [
        { value: 'Prescription', label: 'Prescription' },
        { value: 'Over-the-counter', label: 'Over-the-counter' },
      ] },
      { type: 'text', key: 'prescriber_name', label: 'Prescribing doctor (if prescription)', visible_when: { field: 'medication_type', equals: ['Prescription'] } },
      { type: 'textarea', key: 'special_instructions', label: 'Special instructions / side effects to watch for (optional)' },
      { type: 'paragraph', text: 'Medication must be delivered to the office in its original container, labeled with the child’s name.' },
      ack('ack_original_container', 'I will provide the medication in its original, labeled container'),
      ...sig(),
    ],
  },
  {
    key: 'photo-media-release',
    title: 'Photo & Media Release',
    description: 'Grant or decline permission to use the child’s photo in school materials and social media.',
    category: 'release',
    per_student: true,
    field_schema: [
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'paragraph', text: 'From time to time we photograph or record classroom life for newsletters, our website, and social media. Please tell us your preference for your child.' },
      { type: 'radio', key: 'media_permission', label: 'My choice:', required: true, options: [
        { value: 'Grant - all uses', label: 'I GRANT permission for photos/video in all school materials, including social media' },
        { value: 'Grant - internal only', label: 'I grant permission for INTERNAL use only (classroom, newsletters) — not social media or the public website' },
        { value: 'Decline', label: 'I DECLINE — please do not photograph my child for any published materials' },
      ] },
      ...sig(),
    ],
  },
  {
    key: 'field-trip-permission',
    title: 'Field Trip Permission',
    description: 'A per-trip permission slip — edit the trip details, then publish for the classes attending.',
    category: 'trip',
    per_student: true,
    field_schema: [
      { type: 'section', label: 'Trip details' },
      { type: 'paragraph', text: 'EDIT ME: Describe the trip here — destination, date, departure/return times, transportation, what to bring, and cost if any.' },
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'radio', key: 'permission', label: 'Permission', required: true, options: [
        { value: 'Yes', label: 'My child MAY attend this trip' },
        { value: 'No', label: 'My child may NOT attend this trip' },
      ] },
      { type: 'text', key: 'emergency_contact_name', label: 'Emergency contact during the trip', required: true, prefill: 'health.emergency_contact_name', visible_when: { field: 'permission', equals: ['Yes'] } },
      { type: 'tel', key: 'emergency_contact_phone', label: 'Emergency contact phone', required: true, prefill: 'health.emergency_contact_phone', visible_when: { field: 'permission', equals: ['Yes'] } },
      { type: 'textarea', key: 'trip_notes', label: 'Anything the chaperones should know? (allergies, medications, etc.)', visible_when: { field: 'permission', equals: ['Yes'] } },
      ...sig(),
    ],
  },
  {
    key: 'emergency-medical',
    title: 'Emergency Contact & Medical Information',
    description: 'Emergency contacts, doctor, insurance, allergies, and conditions — answers keep the student’s health profile up to date.',
    category: 'medical',
    per_student: true,
    field_schema: [
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'section', label: 'Emergency contact (other than parents/guardians)' },
      { type: 'text', key: 'emergency_contact_name', label: 'Name', required: true, prefill: 'health.emergency_contact_name' },
      { type: 'tel', key: 'emergency_contact_phone', label: 'Phone', required: true, prefill: 'health.emergency_contact_phone' },
      { type: 'text', key: 'emergency_contact_relationship', label: 'Relationship to the child', required: true, prefill: 'health.emergency_contact_relationship' },
      { type: 'section', label: 'Medical care' },
      { type: 'text', key: 'primary_doctor_name', label: 'Primary doctor', prefill: 'health.primary_doctor_name' },
      { type: 'tel', key: 'primary_doctor_phone', label: 'Doctor’s phone', prefill: 'health.primary_doctor_phone' },
      { type: 'text', key: 'preferred_hospital', label: 'Preferred hospital', prefill: 'health.preferred_hospital' },
      { type: 'text', key: 'health_insurance_provider', label: 'Health insurance provider', prefill: 'health.health_insurance_provider' },
      { type: 'text', key: 'health_insurance_policy_number', label: 'Policy number', prefill: 'health.health_insurance_policy_number' },
      { type: 'section', label: 'Health details' },
      { type: 'textarea', key: 'allergies', label: 'Allergies (or “none”)', required: true, prefill: 'health.allergies' },
      { type: 'textarea', key: 'current_medications', label: 'Current medications (or “none”)', prefill: 'health.current_medications' },
      { type: 'textarea', key: 'medical_conditions', label: 'Medical conditions we should know about (or “none”)', prefill: 'health.medical_conditions' },
      { type: 'paragraph', text: 'EDIT ME: Add your school’s emergency-treatment authorization language here.' },
      ack('ack_emergency_treatment', 'I authorize the school to obtain emergency medical treatment for my child if I cannot be reached'),
      ...sig(),
    ],
  },
  {
    key: 'general-consent',
    title: 'General Consent / Waiver (blank)',
    description: 'A minimal agree-and-sign form — paste your policy text, add any fields, publish.',
    category: 'permission',
    per_student: true,
    field_schema: [
      { type: 'text', key: 'student_name', label: 'Student', prefill: 'student.full_name', readOnly: true },
      { type: 'paragraph', text: 'EDIT ME: Paste your policy or consent language here.' },
      ack('ack_agree', 'I have read and agree to the above'),
      ...sig(),
    ],
  },
];
