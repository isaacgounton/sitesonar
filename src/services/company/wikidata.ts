import {
  type Company,
  CompanyNotFoundError,
  ProviderRequestError,
  rootDomain,
} from './types.js';

const SPARQL_URL = 'https://query.wikidata.org/sparql';

// Wikimedia requires a descriptive User-Agent per their policy.
const UA = 'Sitesonar/1.0 (https://sitesonar.dev; contact via repo) wikidata-client';

interface SparqlBinding {
  value: string;
  type?: string;
  'xml:lang'?: string;
  datatype?: string;
}

interface SparqlRow {
  [key: string]: SparqlBinding | undefined;
}

interface SparqlResponse {
  results?: { bindings?: SparqlRow[] };
}

export interface WikidataLookupArgs {
  domain: string;
  timeoutMs: number;
}

export async function lookupByDomain(args: WikidataLookupArgs): Promise<Company> {
  const domain = rootDomain(args.domain);
  // P856 = official website. Use VALUES with exact URL variants so WDQS
  // does direct index lookups instead of a full scan with REGEX (which
  // times out — there are millions of P856 statements).
  const variants = urlVariants(domain).map((u) => `<${u}>`).join(' ');
  const query = `
    SELECT ?company ?companyLabel ?officialName ?description ?website
           ?hqLabel ?countryCode
           ?founded ?employees ?industryLabel
           ?linkedin ?twitter ?facebook
    WHERE {
      VALUES ?website { ${variants} }
      ?company wdt:P856 ?website .
      OPTIONAL { ?company wdt:P159 ?hq . OPTIONAL { ?hq wdt:P297 ?countryCode . } }
      OPTIONAL { ?company wdt:P1448 ?officialName . FILTER(LANG(?officialName) = "en") }
      OPTIONAL { ?company schema:description ?description . FILTER(LANG(?description) = "en") }
      OPTIONAL { ?company wdt:P571 ?founded . }
      OPTIONAL { ?company wdt:P1128 ?employees . }
      OPTIONAL { ?company wdt:P452 ?industry . }
      OPTIONAL { ?company wdt:P4264 ?linkedin . }
      OPTIONAL { ?company wdt:P2002 ?twitter . }
      OPTIONAL { ?company wdt:P2013 ?facebook . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 1
  `;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(`${SPARQL_URL}?query=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': UA,
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'wikidata',
        null,
        `Timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'wikidata',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new ProviderRequestError('wikidata', resp.status, `HTTP ${resp.status}`);
  }

  let body: SparqlResponse;
  try {
    body = (await resp.json()) as SparqlResponse;
  } catch {
    throw new ProviderRequestError(
      'wikidata',
      resp.status,
      'Non-JSON SPARQL response',
    );
  }

  const row = body.results?.bindings?.[0];
  if (!row) {
    throw new CompanyNotFoundError(`No Wikidata entity for "${domain}"`);
  }

  return toCompany(row, domain);
}

function toCompany(row: SparqlRow, fallbackDomain: string): Company {
  // Skip ?companyLabel if the SERVICE label fell back to the entity URI.
  const label = row.companyLabel?.value;
  const isUriFallback = label?.startsWith('http://www.wikidata.org/entity/');
  const displayLabel = !label || isUriFallback ? null : label;
  const officialName = row.officialName?.value ?? null;

  const description = row.description?.value ?? null;
  const website = row.website?.value ?? `https://${fallbackDomain}`;
  const founded = parseYear(row.founded?.value);
  const employees = row.employees?.value
    ? `~${Number(row.employees.value)}`
    : null;

  return {
    name: officialName ?? displayLabel ?? fallbackDomain,
    domain: rootDomain(website),
    description,
    industry: row.industryLabel?.value ?? null,
    employeeRange: employees,
    foundedYear: founded,
    headquarters: row.hqLabel
      ? {
          street: null,
          city: row.hqLabel.value,
          region: null,
          country: row.countryCode?.value ?? null,
          postalCode: null,
        }
      : null,
    phone: null,
    website,
    socials: {
      // P4264 stores just the slug ("stripe"); the canonical LinkedIn URL
      // is https://www.linkedin.com/company/<slug>.
      linkedin: row.linkedin?.value
        ? `https://www.linkedin.com/company/${row.linkedin.value}`
        : null,
      twitter: row.twitter?.value
        ? `https://twitter.com/${row.twitter.value.replace(/^@/, '')}`
        : null,
      facebook: row.facebook?.value
        ? `https://www.facebook.com/${row.facebook.value}`
        : null,
    },
    source: 'wikidata',
  };
}

function parseYear(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function urlVariants(domain: string): string[] {
  const hosts = [domain, `www.${domain}`];
  const schemes = ['https', 'http'];
  const tails = ['', '/'];
  const out: string[] = [];
  for (const s of schemes) {
    for (const h of hosts) {
      for (const t of tails) {
        out.push(`${s}://${h}${t}`);
      }
    }
  }
  return out;
}
