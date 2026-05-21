import {
  type Company,
  type CompanyHeadquarters,
  ProviderNotConfiguredError,
  ProviderQuotaError,
  ProviderRequestError,
  CompanyNotFoundError,
  emptySocials,
  rootDomain,
} from './types.js';

const BASE_URL = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.internationalPhoneNumber',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.editorialSummary',
  'places.businessStatus',
].join(',');

interface PlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface PlacesResult {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: PlacesAddressComponent[];
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  editorialSummary?: { text?: string };
  businessStatus?: string;
}

interface PlacesResponse {
  places?: PlacesResult[];
  error?: { code?: number; message?: string; status?: string };
}

export interface LookupOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DomainLookupArgs extends LookupOptions {
  domain: string;
  location?: string;
}

export interface QueryLookupArgs extends LookupOptions {
  query: string;
  location?: string;
}

export async function lookupByDomain(args: DomainLookupArgs): Promise<Company> {
  if (!args.apiKey) throw new ProviderNotConfiguredError('google_places');
  const domain = rootDomain(args.domain);
  const brand = domain.split('.').slice(0, -1).join('.') || domain;
  const text = args.location ? `${brand} ${args.location}` : brand;
  const results = await runSearch(text, args);

  // Prefer the result whose websiteUri matches the requested domain.
  const matched = results.find((p) => {
    if (!p.websiteUri) return false;
    return rootDomain(p.websiteUri).endsWith(domain);
  });
  const chosen = matched ?? results[0];
  if (!chosen) {
    throw new CompanyNotFoundError(`No Google Places result for domain "${domain}"`);
  }
  return toCompany(chosen, { fallbackDomain: domain });
}

export async function lookupByQuery(args: QueryLookupArgs): Promise<Company> {
  if (!args.apiKey) throw new ProviderNotConfiguredError('google_places');
  const text = args.location ? `${args.query} ${args.location}` : args.query;
  const results = await runSearch(text, args);
  const chosen = results[0];
  if (!chosen) {
    throw new CompanyNotFoundError(`No Google Places result for query "${args.query}"`);
  }
  return toCompany(chosen, {});
}

async function runSearch(
  textQuery: string,
  opts: LookupOptions,
): Promise<PlacesResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const signal = opts.signal
    ? anySignal([opts.signal, controller.signal])
    : controller.signal;

  let resp: Response;
  try {
    resp = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': opts.apiKey!,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery, pageSize: 5 }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'google_places',
        null,
        `Timed out after ${opts.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'google_places',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  let body: PlacesResponse;
  try {
    body = (await resp.json()) as PlacesResponse;
  } catch {
    throw new ProviderRequestError(
      'google_places',
      resp.status,
      `Non-JSON response (status ${resp.status})`,
    );
  }

  if (!resp.ok) {
    const msg = body.error?.message ?? `HTTP ${resp.status}`;
    if (resp.status === 429 || body.error?.status === 'RESOURCE_EXHAUSTED') {
      throw new ProviderQuotaError('google_places', msg);
    }
    throw new ProviderRequestError('google_places', resp.status, msg);
  }

  return body.places ?? [];
}

function toCompany(
  p: PlacesResult,
  ctx: { fallbackDomain?: string },
): Company {
  const hq = parseAddress(p.addressComponents, p.formattedAddress);
  const phone = p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null;
  const website = p.websiteUri ?? null;
  const domain = website ? rootDomain(website) : (ctx.fallbackDomain ?? null);
  const industry =
    p.primaryTypeDisplayName?.text ??
    formatTypeId(p.primaryType) ??
    formatTypeId(p.types?.[0]);

  return {
    name: p.displayName?.text ?? 'Unknown',
    domain,
    description: p.editorialSummary?.text ?? null,
    industry,
    employeeRange: null,
    foundedYear: null,
    headquarters: hq,
    phone,
    website,
    socials: emptySocials(),
    source: 'google_places',
  };
}

function parseAddress(
  components: PlacesAddressComponent[] | undefined,
  formatted: string | undefined,
): CompanyHeadquarters | null {
  if (!components && !formatted) return null;
  const hq: CompanyHeadquarters = {
    street: null,
    city: null,
    region: null,
    country: null,
    postalCode: null,
  };
  let streetNumber: string | null = null;
  let route: string | null = null;
  for (const c of components ?? []) {
    const t = c.types ?? [];
    const long = c.longText ?? c.shortText ?? null;
    if (!long) continue;
    if (t.includes('street_number')) streetNumber = long;
    else if (t.includes('route')) route = long;
    else if (t.includes('locality') || t.includes('postal_town')) hq.city = long;
    else if (t.includes('administrative_area_level_1')) hq.region = c.shortText ?? long;
    else if (t.includes('country')) hq.country = c.shortText ?? long;
    else if (t.includes('postal_code')) hq.postalCode = long;
  }
  if (streetNumber || route) {
    hq.street = [streetNumber, route].filter(Boolean).join(' ');
  } else if (formatted) {
    hq.street = formatted.split(',')[0]?.trim() ?? null;
  }
  return hq;
}

function formatTypeId(id: string | undefined): string | null {
  if (!id) return null;
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Polyfill — Node's AbortSignal.any is on 20+ but keeping a tiny shim is safer.
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
