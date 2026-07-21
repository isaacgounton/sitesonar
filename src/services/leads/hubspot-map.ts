import type { Lead } from './types.js';

export function industryToTag(industry: string): { value: string; label: string } {
  const words = (industry || '').trim().split(/\s+/).filter(Boolean);
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return {
    value: words.map(cap).join('_'),
    label: words.map(cap).join(' '),
  };
}

export function firstLastFromTitle(title: string): { firstname: string; lastname: string } {
  // Maps results are businesses, not people: use the business name as firstname,
  // matching MapLeads (firstname = title/company fallback, lastname empty).
  return { firstname: title.trim(), lastname: '' };
}

/** Split a real person name into first + rest (e.g. directory leads). */
export function splitPersonName(name: string): { firstname: string; lastname: string } {
  const parts = name.trim().split(/\s+/);
  return { firstname: parts[0] ?? '', lastname: parts.slice(1).join(' ') };
}

export function mapContactProperties(
  lead: Lead,
  opts: { industry?: string; existingProps: Set<string>; typeContactValue?: string },
): Record<string, string> {
  // A directory lead carries a real person in contactName; split that for the
  // contact name and keep title as the company. Business leads have no
  // contactName, so fall back to the legacy business-name-as-firstname mapping.
  const { firstname, lastname } = lead.contactName?.trim()
    ? splitPersonName(lead.contactName)
    : firstLastFromTitle(lead.title);
  const props: Record<string, string> = {
    firstname: firstname || lead.title || 'Business',
    lastname,
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    website: lead.website ?? '',
    company: lead.title ?? '',
    address: lead.address ?? '',
  };

  const has = (p: string): boolean => opts.existingProps.has(p);

  if (has('source')) props.source = 'Google_Maps';
  if (has('statut_outbound')) props.statut_outbound = 'To_Contact';
  if (has('google_maps_link') && lead.googleMapsLink) props.google_maps_link = lead.googleMapsLink;
  if (has('linkedin_url') && lead.linkedin) props.linkedin_url = lead.linkedin;
  if (has('facebook_url') && lead.facebook) props.facebook_url = lead.facebook;
  if (has('instagram_url') && lead.instagram) props.instagram_url = lead.instagram;
  if (has('type_contact') && opts.typeContactValue) props.type_contact = opts.typeContactValue;

  // Drop empty values — HubSpot rejects some empty standard fields.
  for (const k of Object.keys(props)) {
    if (!props[k]) delete props[k];
  }
  return props;
}
