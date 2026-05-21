import type { Config } from '../../config.js';
import {
  type Company,
  type FirmographicsProvider,
  ALL_FIRMOGRAPHICS_PROVIDERS,
  ProviderNotConfiguredError,
  ProviderQuotaError,
  ProviderRequestError,
  CompanyNotFoundError,
  rootDomain,
} from './types.js';
import {
  lookupByDomain as googlePlacesByDomain,
  lookupByQuery as googlePlacesByQuery,
} from './googlePlaces.js';
import {
  lookupByDomain as hunterByDomain,
  lookupContacts as hunterContacts,
} from './hunter.js';
import { lookupByDomain as rdapByDomain } from './rdap.js';
import { lookupByDomain as schemaOrgByDomain } from './schemaOrg.js';
import { lookupByDomain as wikidataByDomain } from './wikidata.js';
import { lookupContacts as apolloContacts, type Contact } from './apollo.js';

export type ContactsProvider = 'hunter' | 'apollo';
export const ALL_CONTACTS_PROVIDERS: ContactsProvider[] = ['hunter', 'apollo'];

export {
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderQuotaError,
  CompanyNotFoundError,
  rootDomain,
  ALL_FIRMOGRAPHICS_PROVIDERS,
} from './types.js';
export type { Company, CompanyHeadquarters, CompanySocials, FirmographicsProvider } from './types.js';
export type { Contact } from './apollo.js';

export interface LookupArgs {
  domain?: string;
  query?: string;
  location?: string;
  firmographicsProvider?: FirmographicsProvider;
  contactsProvider?: ContactsProvider;
  includeFirmographics: boolean;
  includeContacts: boolean;
  contactsLimit: number;
  contactFilters?: {
    titles?: string[];
    departments?: string[];
    seniority?: string[];
  };
}

export interface LookupResult {
  company: Company | null;
  contacts: Contact[];
  providersUsed: string[];
  warnings: string[];
}

interface ProviderAttempt {
  name: FirmographicsProvider;
  ok: boolean;
  error?: string;
  notFound?: boolean;
}

export class NoFirmographicsProvidersError extends Error {
  constructor() {
    super(
      'No firmographics providers are configured. Set HUNTER_API_KEY or GOOGLE_PLACES_API_KEY, or use the always-on rdap provider.',
    );
    this.name = 'NoFirmographicsProvidersError';
  }
}

export class AllProvidersFailedError extends Error {
  constructor(public attempts: ProviderAttempt[]) {
    super(
      `All firmographics providers failed: ${attempts.map((a) => `${a.name}=${a.error ?? 'notFound'}`).join(', ')}`,
    );
    this.name = 'AllProvidersFailedError';
  }
}

function isConfigured(provider: FirmographicsProvider, config: Config): boolean {
  switch (provider) {
    case 'hunter':
      return Boolean(config.hunterApiKey);
    case 'google_places':
      return Boolean(config.googlePlacesApiKey);
    case 'schema_org':
    case 'wikidata':
    case 'rdap':
      return true; // Free, no auth required.
  }
}

function buildChain(
  config: Config,
  override?: FirmographicsProvider,
): FirmographicsProvider[] {
  if (override) {
    if (!isConfigured(override, config)) {
      throw new ProviderNotConfiguredError(override);
    }
    return [override];
  }
  const order = config.companyProviders.length
    ? config.companyProviders
    : ALL_FIRMOGRAPHICS_PROVIDERS;
  return order.filter((p) => isConfigured(p, config));
}

async function runProvider(
  provider: FirmographicsProvider,
  args: LookupArgs,
  config: Config,
): Promise<Company> {
  const timeoutMs = config.companyTimeoutMs;
  switch (provider) {
    case 'hunter': {
      if (!args.domain) {
        // Hunter is domain-first. If we only have a query, skip it.
        throw new ProviderNotConfiguredError('hunter');
      }
      return hunterByDomain({ apiKey: config.hunterApiKey, domain: args.domain, timeoutMs });
    }
    case 'google_places': {
      return args.domain
        ? googlePlacesByDomain({
            domain: args.domain,
            location: args.location,
            apiKey: config.googlePlacesApiKey,
            timeoutMs,
          })
        : googlePlacesByQuery({
            query: args.query!,
            location: args.location,
            apiKey: config.googlePlacesApiKey,
            timeoutMs,
          });
    }
    case 'schema_org': {
      if (!args.domain) {
        throw new ProviderNotConfiguredError('schema_org');
      }
      return schemaOrgByDomain({ domain: args.domain, timeoutMs });
    }
    case 'wikidata': {
      if (!args.domain) {
        throw new ProviderNotConfiguredError('wikidata');
      }
      return wikidataByDomain({ domain: args.domain, timeoutMs });
    }
    case 'rdap': {
      if (!args.domain) {
        throw new ProviderNotConfiguredError('rdap');
      }
      return rdapByDomain({ domain: args.domain, timeoutMs });
    }
  }
}

async function runFirmographicsChain(
  args: LookupArgs,
  config: Config,
): Promise<{ company: Company; providersUsed: string[]; warnings: string[]; attempts: ProviderAttempt[] }> {
  const chain = buildChain(config, args.firmographicsProvider);
  if (chain.length === 0) {
    throw new NoFirmographicsProvidersError();
  }

  const warnings: string[] = [];
  const attempts: ProviderAttempt[] = [];

  for (const provider of chain) {
    try {
      const company = await runProvider(provider, args, config);
      attempts.push({ name: provider, ok: true });
      return { company, providersUsed: [provider], warnings, attempts };
    } catch (err) {
      if (err instanceof CompanyNotFoundError) {
        attempts.push({ name: provider, ok: false, notFound: true });
        continue;
      }
      if (err instanceof ProviderNotConfiguredError) {
        // Skipped silently — the chain shouldn't have included it, but if a
        // provider can't run (e.g. Hunter without a domain), keep going.
        attempts.push({ name: provider, ok: false, error: 'not_applicable' });
        continue;
      }
      const label =
        err instanceof ProviderQuotaError
          ? 'quota_exceeded'
          : err instanceof ProviderRequestError
            ? `error(${err.status ?? 'no_status'})`
            : 'error';
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ name: provider, ok: false, error: label });
      warnings.push(`${provider} ${label}: ${msg}`);
    }
  }

  // No provider succeeded.
  if (attempts.every((a) => a.notFound)) {
    throw new CompanyNotFoundError(
      `No firmographics provider returned a result for ${args.domain ?? args.query}`,
    );
  }
  throw new AllProvidersFailedError(attempts);
}

export async function lookupCompany(
  args: LookupArgs,
  config: Config,
): Promise<LookupResult> {
  const warnings: string[] = [];
  const providersUsed: string[] = [];

  let company: Company | null = null;
  let resolvedDomain: string | null = null;

  if (args.includeFirmographics) {
    const chainResult = await runFirmographicsChain(args, config);
    company = chainResult.company;
    providersUsed.push(...chainResult.providersUsed);
    warnings.push(...chainResult.warnings);
    resolvedDomain = company?.domain ?? null;
  }

  const contactsDomain = args.domain
    ? rootDomain(args.domain)
    : resolvedDomain;

  let contacts: Contact[] = [];
  if (args.includeContacts) {
    if (!contactsDomain) {
      warnings.push(
        'contacts requested but no domain was provided or resolvable from firmographics',
      );
    } else {
      const chain = buildContactsChain(config, args.contactsProvider);
      if (chain.length === 0) {
        warnings.push(
          'contacts requested but no contacts provider is configured (set HUNTER_API_KEY or APOLLO_API_KEY)',
        );
      } else {
        let succeeded = false;
        for (const provider of chain) {
          try {
            contacts = await runContactsProvider(provider, contactsDomain, args, config);
            providersUsed.push(provider);
            succeeded = true;
            break;
          } catch (err) {
            const label =
              err instanceof ProviderQuotaError
                ? 'quota exceeded'
                : err instanceof ProviderRequestError
                  ? `failed (${err.status ?? 'no status'})`
                  : 'failed';
            warnings.push(
              `${provider} ${label}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (!succeeded && !args.includeFirmographics) {
          // Contacts is the only thing asked for and every provider failed.
          throw new AllProvidersFailedError(
            chain.map((name) => ({ name: name as FirmographicsProvider, ok: false })),
          );
        }
      }
    }
  }

  return { company, contacts, providersUsed, warnings };
}

function buildContactsChain(
  config: Config,
  override?: ContactsProvider,
): ContactsProvider[] {
  if (override) {
    if (!isContactsConfigured(override, config)) {
      throw new ProviderNotConfiguredError(override);
    }
    return [override];
  }
  const order = config.contactsProviders.length
    ? config.contactsProviders
    : ALL_CONTACTS_PROVIDERS;
  return order.filter((p) => isContactsConfigured(p, config));
}

function isContactsConfigured(provider: ContactsProvider, config: Config): boolean {
  switch (provider) {
    case 'hunter':
      return Boolean(config.hunterApiKey);
    case 'apollo':
      return Boolean(config.apolloApiKey);
  }
}

async function runContactsProvider(
  provider: ContactsProvider,
  domain: string,
  args: LookupArgs,
  config: Config,
): Promise<Contact[]> {
  switch (provider) {
    case 'hunter':
      return hunterContacts({
        apiKey: config.hunterApiKey,
        domain,
        limit: args.contactsLimit,
        titles: args.contactFilters?.titles,
        departments: args.contactFilters?.departments,
        seniority: args.contactFilters?.seniority,
        timeoutMs: config.companyTimeoutMs,
      });
    case 'apollo':
      return apolloContacts({
        apiKey: config.apolloApiKey,
        domain,
        limit: args.contactsLimit,
        titles: args.contactFilters?.titles,
        departments: args.contactFilters?.departments,
        seniority: args.contactFilters?.seniority,
        timeoutMs: config.companyTimeoutMs,
      });
  }
}
