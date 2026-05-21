export interface CompanyHeadquarters {
  street: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
}

export interface CompanySocials {
  linkedin: string | null;
  twitter: string | null;
  facebook: string | null;
}

export interface Company {
  name: string;
  domain: string | null;
  description: string | null;
  industry: string | null;
  employeeRange: string | null;
  foundedYear: number | null;
  headquarters: CompanyHeadquarters | null;
  phone: string | null;
  website: string | null;
  socials: CompanySocials;
  source: FirmographicsProvider;
}

export type FirmographicsProvider =
  | 'hunter'
  | 'google_places'
  | 'schema_org'
  | 'wikidata'
  | 'rdap';

export const ALL_FIRMOGRAPHICS_PROVIDERS: FirmographicsProvider[] = [
  'hunter',
  'google_places',
  'schema_org',
  'wikidata',
  'rdap',
];

export class ProviderNotConfiguredError extends Error {
  constructor(public provider: string) {
    super(`${provider} is not configured`);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderRequestError extends Error {
  constructor(
    public provider: string,
    public status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export class ProviderQuotaError extends Error {
  constructor(public provider: string, message: string) {
    super(message);
    this.name = 'ProviderQuotaError';
  }
}

export class CompanyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyNotFoundError';
  }
}

export function emptySocials(): CompanySocials {
  return { linkedin: null, twitter: null, facebook: null };
}

export function rootDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0]!;
  s = s.split('?')[0]!;
  return s;
}
