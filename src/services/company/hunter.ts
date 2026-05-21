import {
  type Company,
  type CompanyHeadquarters,
  type CompanySocials,
  ProviderNotConfiguredError,
  ProviderQuotaError,
  ProviderRequestError,
  CompanyNotFoundError,
  rootDomain,
} from './types.js';
import type { Contact } from './apollo.js';

const BASE_URL = 'https://api.hunter.io/v2/companies/find';
const DOMAIN_SEARCH_URL = 'https://api.hunter.io/v2/domain-search';

interface HunterCompany {
  id?: number;
  name?: string;
  legalName?: string;
  domain?: string;
  description?: string | null;
  foundedYear?: number | null;
  location?: string | null;
  timeZone?: string | null;
  geo?: {
    streetNumber?: string | null;
    streetName?: string | null;
    subPremise?: string | null;
    city?: string | null;
    postalCode?: string | null;
    state?: string | null;
    stateCode?: string | null;
    country?: string | null;
    countryCode?: string | null;
  } | null;
  phone?: string | null;
  linkedin?: { handle?: string | null } | null;
  twitter?: { handle?: string | null } | null;
  facebook?: { handle?: string | null } | null;
  category?: { industry?: string | null; subIndustry?: string | null } | null;
  metrics?: { employees?: number | null; employeesRange?: string | null } | null;
}

interface HunterResponse {
  data?: HunterCompany;
  errors?: Array<{ id?: string; code?: number; details?: string }>;
}

export interface HunterLookupArgs {
  apiKey: string | undefined;
  domain: string;
  timeoutMs: number;
}

export async function lookupByDomain(args: HunterLookupArgs): Promise<Company> {
  if (!args.apiKey) throw new ProviderNotConfiguredError('hunter');
  const domain = rootDomain(args.domain);
  const url = `${BASE_URL}?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(args.apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'hunter',
        null,
        `Timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'hunter',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  let body: HunterResponse;
  try {
    body = (await resp.json()) as HunterResponse;
  } catch {
    throw new ProviderRequestError(
      'hunter',
      resp.status,
      `Non-JSON response (status ${resp.status})`,
    );
  }

  if (resp.status === 404 || (resp.ok && !body.data)) {
    throw new CompanyNotFoundError(`No Hunter result for domain "${domain}"`);
  }
  if (!resp.ok) {
    const msg =
      body.errors?.[0]?.details ?? body.errors?.[0]?.id ?? `HTTP ${resp.status}`;
    if (resp.status === 429 || resp.status === 402) {
      throw new ProviderQuotaError('hunter', msg);
    }
    throw new ProviderRequestError('hunter', resp.status, msg);
  }

  return toCompany(body.data!, domain);
}

function toCompany(c: HunterCompany, fallbackDomain: string): Company {
  const hq = parseAddress(c.geo, c.location);
  // Hunter returns the LinkedIn handle as "company/<slug>" (full path);
  // Twitter and Facebook return just the bare slug.
  const socials: CompanySocials = {
    linkedin: handleToUrl(c.linkedin?.handle, 'https://www.linkedin.com/'),
    twitter: handleToUrl(c.twitter?.handle, 'https://twitter.com/'),
    facebook: handleToUrl(c.facebook?.handle, 'https://www.facebook.com/'),
  };
  const industry =
    c.category?.industry ??
    c.category?.subIndustry ??
    null;
  const employeeRange =
    c.metrics?.employeesRange ??
    (c.metrics?.employees != null ? `~${c.metrics.employees}` : null);

  return {
    name: c.name ?? c.legalName ?? fallbackDomain,
    domain: c.domain ?? fallbackDomain,
    description: c.description ?? null,
    industry,
    employeeRange,
    foundedYear: c.foundedYear ?? null,
    headquarters: hq,
    phone: c.phone ?? null,
    website: c.domain ? `https://${c.domain}` : `https://${fallbackDomain}`,
    socials,
    source: 'hunter',
  };
}

function parseAddress(
  geo: HunterCompany['geo'],
  fallback: string | null | undefined,
): CompanyHeadquarters | null {
  if (!geo && !fallback) return null;
  const hq: CompanyHeadquarters = {
    street: null,
    city: null,
    region: null,
    country: null,
    postalCode: null,
  };
  if (geo) {
    const street = [geo.streetNumber, geo.streetName].filter(Boolean).join(' ');
    hq.street = street || null;
    hq.city = geo.city ?? null;
    hq.region = geo.stateCode ?? geo.state ?? null;
    hq.country = geo.countryCode ?? geo.country ?? null;
    hq.postalCode = geo.postalCode ?? null;
  } else if (fallback) {
    // No structured geo — use the formatted location string as a best-effort
    // city/region hint rather than mis-attributing it as a street.
    hq.city = fallback.split(',')[0]?.trim() ?? null;
  }
  return hq;
}

function handleToUrl(handle: string | null | undefined, prefix: string): string | null {
  if (!handle) return null;
  return prefix + handle.replace(/^@/, '');
}

// ---- Domain Search for contacts ----

interface HunterEmail {
  value?: string;
  type?: string;
  confidence?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  linkedin?: string | null;
}

interface HunterDomainSearchResponse {
  data?: {
    domain?: string;
    pattern?: string | null;
    emails?: HunterEmail[];
  };
  errors?: Array<{ id?: string; code?: number; details?: string }>;
}

export interface HunterContactsArgs {
  apiKey: string | undefined;
  domain: string;
  limit: number;
  titles?: string[];
  departments?: string[];
  seniority?: string[];
  timeoutMs: number;
}

// Map Apollo's seniority enum onto Hunter's three-level enum so the API
// surface stays consistent across providers.
function toHunterSeniority(s: string): string {
  switch (s) {
    case 'c_suite':
    case 'vp':
    case 'director':
      return 'executive';
    case 'manager':
    case 'senior':
      return 'senior';
    case 'individual_contributor':
      return 'junior';
    default:
      return s; // already a Hunter value
  }
}

export async function lookupContacts(args: HunterContactsArgs): Promise<Contact[]> {
  if (!args.apiKey) throw new ProviderNotConfiguredError('hunter');
  const domain = rootDomain(args.domain);

  const params = new URLSearchParams({
    domain,
    api_key: args.apiKey,
    limit: String(Math.min(Math.max(args.limit, 1), 100)),
  });
  if (args.departments?.length) {
    params.set('department', args.departments.map((d) => d.toLowerCase()).join(','));
  }
  if (args.seniority?.length) {
    const mapped = Array.from(new Set(args.seniority.map(toHunterSeniority)));
    params.set('seniority', mapped.join(','));
  }
  // Hunter has no title filter; we post-filter client-side below.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(`${DOMAIN_SEARCH_URL}?${params}`, {
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'hunter',
        null,
        `Timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'hunter',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  let body: HunterDomainSearchResponse;
  try {
    body = (await resp.json()) as HunterDomainSearchResponse;
  } catch {
    throw new ProviderRequestError(
      'hunter',
      resp.status,
      `Non-JSON response (status ${resp.status})`,
    );
  }

  if (!resp.ok) {
    const msg =
      body.errors?.[0]?.details ?? body.errors?.[0]?.id ?? `HTTP ${resp.status}`;
    if (resp.status === 429 || resp.status === 402) {
      throw new ProviderQuotaError('hunter', msg);
    }
    throw new ProviderRequestError('hunter', resp.status, msg);
  }

  let emails = body.data?.emails ?? [];

  if (args.titles?.length) {
    const needles = args.titles.map((t) => t.toLowerCase());
    emails = emails.filter((e) =>
      e.position ? needles.some((n) => e.position!.toLowerCase().includes(n)) : false,
    );
  }

  return emails.slice(0, args.limit).map(toContact);
}

function toContact(e: HunterEmail): Contact {
  const name =
    [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Unknown';
  return {
    name,
    title: e.position ?? null,
    department: e.department ?? null,
    seniority: e.seniority ?? null,
    email: e.value ?? null,
    emailStatus:
      e.confidence != null ? `confidence:${e.confidence}` : (e.type ?? null),
    linkedinUrl: e.linkedin ?? null,
    source: 'hunter',
  };
}
