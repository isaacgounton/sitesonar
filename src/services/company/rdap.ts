import {
  type Company,
  type CompanyHeadquarters,
  CompanyNotFoundError,
  ProviderRequestError,
  emptySocials,
  rootDomain,
} from './types.js';

// rdap.org is a free RDAP redirector that finds the right registry for any TLD.
const BASE_URL = 'https://rdap.org/domain/';

interface RdapVcardProperty extends Array<unknown> {
  0: string;          // property name (fn, adr, tel, email, org)
  1: Record<string, unknown>;  // parameters
  2: string;          // type (text, uri)
  3: unknown;         // value
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: ['vcard', RdapVcardProperty[]];
  entities?: RdapEntity[];
}

interface RdapDomainResponse {
  ldhName?: string;
  entities?: RdapEntity[];
  errorCode?: number;
  title?: string;
  description?: string[];
}

export interface RdapLookupArgs {
  domain: string;
  timeoutMs: number;
}

export async function lookupByDomain(args: RdapLookupArgs): Promise<Company> {
  const domain = rootDomain(args.domain);
  const url = BASE_URL + encodeURIComponent(domain);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' },
      redirect: 'follow',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'rdap',
        null,
        `Timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'rdap',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 404) {
    throw new CompanyNotFoundError(`No RDAP registration for "${domain}"`);
  }
  if (!resp.ok) {
    throw new ProviderRequestError('rdap', resp.status, `HTTP ${resp.status}`);
  }

  let body: RdapDomainResponse;
  try {
    body = (await resp.json()) as RdapDomainResponse;
  } catch {
    throw new ProviderRequestError(
      'rdap',
      resp.status,
      'Non-JSON RDAP response',
    );
  }

  const registrant = findRegistrant(body.entities);
  const company = registrant ? extractFromVcard(registrant, domain) : null;
  if (!company) {
    // The domain resolved but registrant data is fully redacted (common with
    // privacy-protected consumer domains). Surface this as not-found so the
    // chain can move on.
    throw new CompanyNotFoundError(
      `RDAP for "${domain}" returned no usable registrant data (likely privacy-protected)`,
    );
  }
  return company;
}

function findRegistrant(entities: RdapEntity[] | undefined): RdapEntity | null {
  if (!entities) return null;
  for (const e of entities) {
    if (e.roles?.includes('registrant')) return e;
    // Nested registrant under registrar entity is common.
    const nested = findRegistrant(e.entities);
    if (nested) return nested;
  }
  return null;
}

function extractFromVcard(entity: RdapEntity, domain: string): Company | null {
  const vcard = entity.vcardArray?.[1];
  if (!vcard) return null;

  let fn: string | null = null;
  let org: string | null = null;
  let tel: string | null = null;
  let address: string[] | null = null;

  for (const prop of vcard) {
    const [name, , , value] = prop;
    if (name === 'fn' && typeof value === 'string') fn = value;
    else if (name === 'org') {
      if (typeof value === 'string') org = value;
      else if (Array.isArray(value)) org = value[0] as string;
    } else if (name === 'tel' && typeof value === 'string') tel = value;
    else if (name === 'adr' && Array.isArray(value)) address = value as string[];
  }

  const name = org ?? fn;
  if (!name || /^(redacted|private|protected|domains by proxy)/i.test(name)) {
    return null;
  }

  return {
    name,
    domain,
    description: null,
    industry: null,
    employeeRange: null,
    foundedYear: null,
    headquarters: parseAddress(address),
    phone: tel,
    website: `https://${domain}`,
    socials: emptySocials(),
    source: 'rdap',
  };
}

function parseAddress(adr: string[] | null): CompanyHeadquarters | null {
  if (!adr) return null;
  // vCard adr structure: [pobox, ext, street, locality, region, postal, country]
  const [, , street, city, region, postal, country] = adr;
  if (!street && !city && !region && !country && !postal) return null;
  return {
    street: street || null,
    city: city || null,
    region: region || null,
    country: country || null,
    postalCode: postal || null,
  };
}
