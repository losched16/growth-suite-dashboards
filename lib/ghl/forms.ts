// GHL Forms + Surveys API helpers — used to backfill legacy submissions
// from a school's native GHL forms into our portal_form_submissions
// table so the Document Tracker reflects them.
//
// GHL docs:
//   GET /forms/                       list forms in a location
//   GET /forms/submissions             list submissions across forms
//                                       (locationId required, optional formId filter)
//   GET /surveys/                     list surveys
//   GET /surveys/submissions          list submissions across surveys
//
// All endpoints paginate via { page, limit } query params. We cap limit
// at 100 (GHL hard limit) and walk pages until exhausted.

import type { GhlClient } from './client';

export interface GhlForm {
  id: string;
  name: string;
  locationId?: string;
  createdAt?: string;
}

export interface GhlFormSubmission {
  id: string;
  formId?: string;
  surveyId?: string;
  contactId?: string;
  // GHL returns submission data as an object keyed by field id/label
  others?: Record<string, unknown>;     // older response shape
  formData?: Record<string, unknown>;   // newer response shape
  // Some endpoints also return a `name` (form display) and `submissionAt`.
  name?: string;
  createdAt?: string;
  submissionAt?: string;
}

export async function listGhlForms(client: GhlClient): Promise<GhlForm[]> {
  const out: GhlForm[] = [];
  let page = 1;
  while (true) {
    const { data } = await client.axios.get<{ forms?: GhlForm[] }>(
      `/forms/`,
      { params: { locationId: client.locationId, page, limit: 100 } },
    );
    const batch = data.forms ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

export async function listGhlSurveys(client: GhlClient): Promise<GhlForm[]> {
  const out: GhlForm[] = [];
  let page = 1;
  while (true) {
    const { data } = await client.axios.get<{ surveys?: GhlForm[] }>(
      `/surveys/`,
      { params: { locationId: client.locationId, page, limit: 100 } },
    );
    const batch = data.surveys ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

export async function listGhlFormSubmissions(
  client: GhlClient,
  opts: { formId?: string } = {},
): Promise<GhlFormSubmission[]> {
  const out: GhlFormSubmission[] = [];
  let page = 1;
  while (true) {
    const { data } = await client.axios.get<{ submissions?: GhlFormSubmission[]; meta?: { total?: number } }>(
      `/forms/submissions`,
      {
        params: {
          locationId: client.locationId,
          formId: opts.formId,
          page,
          limit: 100,
        },
      },
    );
    const batch = data.submissions ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

export async function listGhlSurveySubmissions(
  client: GhlClient,
  opts: { surveyId?: string } = {},
): Promise<GhlFormSubmission[]> {
  const out: GhlFormSubmission[] = [];
  let page = 1;
  while (true) {
    const { data } = await client.axios.get<{ submissions?: GhlFormSubmission[] }>(
      `/surveys/submissions`,
      {
        params: {
          locationId: client.locationId,
          surveyId: opts.surveyId,
          page,
          limit: 100,
        },
      },
    );
    const batch = data.submissions ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}
