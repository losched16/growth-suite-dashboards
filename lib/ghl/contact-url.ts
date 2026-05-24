// URL builder for "Open Full Contact Record" deep-links into the CRM.
// Pattern is `{base}/v2/location/{locationId}/contacts/detail/{contactId}`.
//
// Our deploys live behind the `app.mygrowthsuite.com` white-label
// domain. Operators never access `app.gohighlevel.com` directly, so
// the default here matches our brand. Override via `CRM_APP_BASE` env
// if a different deploy ever needs a different domain.
//
// Used by widgets that have a `ghl_contact_id` for a parent/contact —
// rendered as a small "Open in GHL" link in the FamilyHub accordion and
// anywhere else we surface contact details.

const DEFAULT_CRM_APP_BASE = 'https://app.mygrowthsuite.com';

export function crmAppBase(): string {
  return process.env.CRM_APP_BASE?.trim() || DEFAULT_CRM_APP_BASE;
}

export function ghlContactUrl(locationId: string, contactId: string): string {
  return `${crmAppBase()}/v2/location/${locationId}/contacts/detail/${contactId}`;
}
