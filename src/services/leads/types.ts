/** A lead flows through scrape -> enrich -> hubspot, each stage adding fields. */
export interface Lead {
  // From /scrape
  title: string;
  /**
   * The named person at this lead (e.g. an attorney), when the source is a
   * people-directory rather than a business listing. `title` stays the firm/
   * company; HubSpot splits contactName into first/last when present.
   */
  contactName?: string;
  rating?: number;
  reviewCount?: number;
  phone?: string;
  category?: string;
  address?: string;
  website?: string;
  googleMapsLink?: string;
  // Added by /enrich
  email?: string;
  emailConfidence?: 'scraped' | 'guessed';
  description?: string;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  // Added by /hubspot
  hubspotId?: string;
}

/** Google redirected to /sorry/ or a sign-in wall — IP likely blocked. */
export class MapsBlockedError extends Error {
  constructor(public url: string) {
    super(`Google blocked the request (url: ${url}). Configure a residential proxy.`);
    this.name = 'MapsBlockedError';
  }
}

/** No HubSpot token in the request body or HUBSPOT_TOKEN env. */
export class HubspotNotConfiguredError extends Error {
  constructor() {
    super('No HubSpot token provided (set request `token` or HUBSPOT_TOKEN env).');
    this.name = 'HubspotNotConfiguredError';
  }
}

/** Compose the Maps search text. Raw `query` wins; else "<industry> <location>". */
export function composeQuery(opts: {
  query?: string;
  industry?: string;
  location?: string;
}): string {
  if (opts.query && opts.query.trim()) return opts.query.trim();
  const parts = [opts.industry?.trim(), opts.location?.trim()].filter(Boolean);
  return parts.join(' ');
}
