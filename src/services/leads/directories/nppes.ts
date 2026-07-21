import { Lead } from '../types.js';
import type { DirectoryArgs, DirectorySource } from './registry.js';

/**
 * NPPES NPI Registry — the official CMS registry of every US healthcare
 * provider (dentists, chiropractors, optometrists, therapists, ...). A free
 * government JSON API (no key, no scraping), so it never breaks on markup
 * changes. Yields named providers with phone + address + specialty. No email
 * (NPI carries none), so these are call/mail leads — yieldsEmail is false.
 *
 * Proves the registry handles an API source as cleanly as an HTML scrape.
 */
const API = 'https://npiregistry.cms.hhs.gov/api/';
const UA = 'sitesonar-leads/1.0 (+https://github.com/DAHO/sitesonar)';

// Healthcare industry keyword -> NPPES taxonomy_description. The API does a
// prefix match, so "Dentist" catches "Dentist, Periodontics" etc. Unmapped
// terms don't match (covers=false) so we never return noise.
// ponytail: extend as you target more specialties.
const TAXONOMY: Record<string, string> = {
  dentist: 'Dentist',
  dental: 'Dentist',
  orthodontist: 'Dentist',
  chiropractor: 'Chiropractor',
  chiro: 'Chiropractor',
  optometrist: 'Optometrist',
  optometry: 'Optometrist',
  podiatrist: 'Podiatrist',
  'physical therapist': 'Physical Therapist',
  physiotherapist: 'Physical Therapist',
  physio: 'Physical Therapist',
  'occupational therapist': 'Occupational Therapist',
  'speech therapist': 'Speech-Language Pathologist',
  psychologist: 'Psychologist',
  dermatologist: 'Dermatology',
  dermatology: 'Dermatology',
  'nurse practitioner': 'Nurse Practitioner',
  acupuncturist: 'Acupuncturist',
  acupuncture: 'Acupuncturist',
  midwife: 'Midwife',
  audiologist: 'Audiologist',
  dietitian: 'Dietitian, Registered',
  nutritionist: 'Nutritionist',
  pharmacy: 'Pharmacy',
  pharmacist: 'Pharmacist',
  optician: 'Optician',
};

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
};
const STATE_CODES = new Set(Object.values(US_STATES));

/** Map a healthcare industry term to an NPPES taxonomy, or undefined. */
export function taxonomyFor(industry: string): string | undefined {
  const i = industry.toLowerCase();
  // Longest key first so "physical therapist" wins over a bare word.
  for (const k of Object.keys(TAXONOMY).sort((a, b) => b.length - a.length)) {
    if (i.includes(k)) return TAXONOMY[k];
  }
  return undefined;
}

/** Resolve a US state code from a location like "Tampa, FL" or "Tampa, Florida". */
export function usStateFrom(location: string): string | undefined {
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
  const tail = parts[parts.length - 1] ?? '';
  const up = tail.toUpperCase();
  if (up.length === 2 && STATE_CODES.has(up)) return up;
  const named = US_STATES[tail.toLowerCase()];
  if (named) return named;
  const m = up.match(/\b([A-Z]{2})\b/); // e.g. "FL 33601"
  if (m && STATE_CODES.has(m[1]!)) return m[1]!;
  return undefined;
}

/** City portion of a location ("Tampa, FL" -> "Tampa"; "" if just a state). */
export function cityFrom(location: string): string {
  const city = location.split(',')[0]?.trim() ?? '';
  return /^(fl|florida)$/i.test(city) || usStateFrom(city) || up2(city) ? '' : city;
}
const up2 = (s: string): boolean => s.length === 2 && STATE_CODES.has(s.toUpperCase());

interface NppesAddr {
  address_purpose?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  telephone_number?: string;
}
interface NppesResult {
  basic?: {
    first_name?: string;
    last_name?: string;
    organization_name?: string;
    authorized_official_first_name?: string;
    authorized_official_last_name?: string;
  };
  addresses?: NppesAddr[];
  taxonomies?: Array<{ desc?: string; primary?: boolean }>;
}

/** Convert one NPPES result into a Lead, or null if it has no usable name. */
export function resultToLead(r: NppesResult): Lead | null {
  const b = r.basic ?? {};
  const org = (b.organization_name ?? '').trim();
  const person = [b.first_name, b.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  const title = org || person;
  if (!title) return null;

  const lead: Lead = { title };
  const contact = org
    ? [b.authorized_official_first_name, b.authorized_official_last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ')
    : person;
  if (contact) lead.contactName = contact;

  const addrs = r.addresses ?? [];
  const loc = addrs.find((a) => a.address_purpose === 'LOCATION') ?? addrs[0];
  if (loc?.telephone_number) lead.phone = loc.telephone_number.trim();
  if (loc) {
    const addr = [[loc.address_1, loc.address_2].filter(Boolean).join(' ').trim(), loc.city, loc.state]
      .filter(Boolean)
      .join(', ');
    if (addr) lead.address = addr;
  }

  const taxes = r.taxonomies ?? [];
  const tax = taxes.find((t) => t.primary) ?? taxes[0];
  if (tax?.desc) lead.category = tax.desc;
  return lead;
}

async function scrape(args: DirectoryArgs): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const taxonomy = taxonomyFor(args.industry);
  const state = usStateFrom(args.location);
  if (!taxonomy || !state) {
    return {
      leads: [],
      warnings: ['nppes-npi: needs a healthcare specialty + US state (e.g. industry "dentist", location "Tampa, FL")'],
    };
  }
  const city = cityFrom(args.location);

  const params = new URLSearchParams({
    version: '2.1',
    state,
    taxonomy_description: taxonomy,
    limit: String(Math.min(200, Math.max(1, args.max))), // API caps at 200
  });
  if (city) params.set('city', city);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const leads: Lead[] = [];
  try {
    const res = await fetch(`${API}?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from npiregistry.cms.hhs.gov`);
    const data = (await res.json()) as { results?: NppesResult[]; Errors?: Array<{ description?: string }> };
    if (data.Errors?.length) warnings.push(`nppes-npi: ${data.Errors.map((e) => e.description).join('; ')}`);
    for (const r of data.results ?? []) {
      const lead = resultToLead(r);
      if (lead) leads.push(lead);
      if (leads.length >= args.max) break;
    }
  } catch (err) {
    warnings.push(`nppes-npi fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!leads.length && !warnings.length) {
    warnings.push(`nppes-npi: no ${taxonomy} providers in ${city || state}`);
  }
  return { leads, warnings };
}

export const nppesNpi: DirectorySource = {
  id: 'nppes-npi',
  label: 'NPPES NPI Registry — US Healthcare Providers',
  sector: 'medical',
  specialties: Object.values(TAXONOMY).filter((v, i, a) => a.indexOf(v) === i),
  regions: ['US'],
  yieldsEmail: false,
  covers({ industry, location }) {
    return Boolean(taxonomyFor(industry)) && Boolean(usStateFrom(location));
  },
  scrape,
};
