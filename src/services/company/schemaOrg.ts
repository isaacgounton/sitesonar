import * as cheerio from 'cheerio';
import {
  type Company,
  type CompanyHeadquarters,
  type CompanySocials,
  CompanyNotFoundError,
  ProviderRequestError,
  emptySocials,
  rootDomain,
} from './types.js';

const ORG_TYPES = new Set([
  'organization',
  'corporation',
  'localbusiness',
  'onlinebusiness',
  'professionalservice',
  'educationalorganization',
  'governmentorganization',
  'ngo',
  'newsmediaorganization',
  'medicalorganization',
]);

export interface SchemaOrgLookupArgs {
  domain: string;
  timeoutMs: number;
}

export async function lookupByDomain(args: SchemaOrgLookupArgs): Promise<Company> {
  const domain = rootDomain(args.domain);
  // Try https://www. first (covers most marketing sites); fall back to apex.
  const candidates = [`https://www.${domain}/`, `https://${domain}/`];

  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const html = await fetchHtml(url, args.timeoutMs);
      const org = extractOrganization(html);
      if (org) {
        return toCompany(org, domain);
      }
      lastErr = new CompanyNotFoundError(
        `No schema.org Organization found at ${url}`,
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new CompanyNotFoundError(`schema_org lookup failed for ${domain}`);
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some sites gate static HTML behind a UA check.
        'User-Agent':
          'Mozilla/5.0 (compatible; Sitesonar/1.0; +https://sitesonar.dev)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!resp.ok) {
      throw new ProviderRequestError('schema_org', resp.status, `HTTP ${resp.status}`);
    }
    return await resp.text();
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'schema_org',
        null,
        `Timed out after ${timeoutMs}ms`,
      );
    }
    if (err instanceof ProviderRequestError) throw err;
    throw new ProviderRequestError(
      'schema_org',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

interface OrgNode {
  '@type'?: string | string[];
  name?: string;
  legalName?: string;
  url?: string;
  description?: string;
  foundingDate?: string;
  numberOfEmployees?: number | string | { value?: number; minValue?: number };
  telephone?: string;
  email?: string;
  address?: PostalAddress | PostalAddress[] | string;
  sameAs?: string | string[];
  logo?: string | { url?: string };
  industry?: string;
}

interface PostalAddress {
  '@type'?: string;
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string | { name?: string };
  postalCode?: string;
}

function extractOrganization(html: string): OrgNode | null {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]');
  for (const el of blocks.toArray()) {
    const raw = $(el).contents().text().trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const found = findOrganization(parsed);
    if (found) return found;
  }
  return null;
}

function findOrganization(node: unknown): OrgNode | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findOrganization(n);
      if (f) return f;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj['@graph'])) {
    const f = findOrganization(obj['@graph']);
    if (f) return f;
  }

  const t = obj['@type'];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  for (const ty of types) {
    if (typeof ty === 'string' && ORG_TYPES.has(ty.toLowerCase())) {
      return obj as OrgNode;
    }
  }
  return null;
}

function toCompany(org: OrgNode, fallbackDomain: string): Company {
  const hq = parseAddress(org.address);
  const socials = parseSocials(org.sameAs);
  const employeeRange = parseEmployees(org.numberOfEmployees);
  const foundedYear = parseYear(org.foundingDate);
  const website = org.url ?? `https://${fallbackDomain}`;

  return {
    name: org.name ?? org.legalName ?? fallbackDomain,
    domain: website ? rootDomain(website) : fallbackDomain,
    description: org.description ?? null,
    industry: org.industry ?? null,
    employeeRange,
    foundedYear,
    headquarters: hq,
    phone: org.telephone ?? null,
    website,
    socials,
    source: 'schema_org',
  };
}

function parseAddress(
  a: OrgNode['address'],
): CompanyHeadquarters | null {
  if (!a) return null;
  const addr: PostalAddress | null = Array.isArray(a)
    ? (a[0] ?? null)
    : typeof a === 'string'
      ? { streetAddress: a }
      : a;
  if (!addr) return null;
  const country =
    typeof addr.addressCountry === 'string'
      ? addr.addressCountry
      : (addr.addressCountry?.name ?? null);
  return {
    street: addr.streetAddress ?? null,
    city: addr.addressLocality ?? null,
    region: addr.addressRegion ?? null,
    country,
    postalCode: addr.postalCode ?? null,
  };
}

function parseSocials(sameAs: OrgNode['sameAs']): CompanySocials {
  const out: CompanySocials = emptySocials();
  if (!sameAs) return out;
  const urls = Array.isArray(sameAs) ? sameAs : [sameAs];
  for (const u of urls) {
    if (typeof u !== 'string') continue;
    const lower = u.toLowerCase();
    if (!out.linkedin && lower.includes('linkedin.com')) out.linkedin = u;
    else if (!out.twitter && (lower.includes('twitter.com') || lower.includes('x.com'))) out.twitter = u;
    else if (!out.facebook && lower.includes('facebook.com')) out.facebook = u;
  }
  return out;
}

function parseEmployees(n: OrgNode['numberOfEmployees']): string | null {
  if (n == null) return null;
  if (typeof n === 'number') return `~${n}`;
  if (typeof n === 'string') return n;
  if (typeof n === 'object') {
    if (typeof n.value === 'number') return `~${n.value}`;
    if (typeof n.minValue === 'number') return `${n.minValue}+`;
  }
  return null;
}

function parseYear(d: string | undefined): number | null {
  if (!d) return null;
  const m = d.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}
