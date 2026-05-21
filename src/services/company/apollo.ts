import {
  ProviderNotConfiguredError,
  ProviderQuotaError,
  ProviderRequestError,
} from './types.js';

const SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/search';

export interface Contact {
  name: string;
  title: string | null;
  department: string | null;
  seniority: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  source: 'apollo' | 'hunter';
}

export interface ApolloLookupArgs {
  apiKey: string | undefined;
  domain: string;
  limit: number;
  titles?: string[];
  departments?: string[];
  seniority?: string[];
  timeoutMs: number;
}

interface ApolloPerson {
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  departments?: string[] | null;
  seniority?: string | null;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
}

interface ApolloSearchResponse {
  people?: ApolloPerson[];
  // Apollo returns assorted error shapes; capture both.
  error?: string;
  error_message?: string;
}

export async function lookupContacts(args: ApolloLookupArgs): Promise<Contact[]> {
  if (!args.apiKey) throw new ProviderNotConfiguredError('apollo');

  const body: Record<string, unknown> = {
    q_organization_domains_list: [args.domain],
    page: 1,
    per_page: Math.min(Math.max(args.limit, 1), 25),
  };
  if (args.titles?.length) body.person_titles = args.titles;
  if (args.departments?.length) body.person_departments = args.departments;
  if (args.seniority?.length) body.person_seniorities = args.seniority;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': args.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderRequestError(
        'apollo',
        null,
        `Timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new ProviderRequestError(
      'apollo',
      null,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  let json: ApolloSearchResponse;
  try {
    json = (await resp.json()) as ApolloSearchResponse;
  } catch {
    throw new ProviderRequestError(
      'apollo',
      resp.status,
      `Non-JSON response (status ${resp.status})`,
    );
  }

  if (!resp.ok) {
    const msg = json.error_message ?? json.error ?? `HTTP ${resp.status}`;
    if (resp.status === 429 || resp.status === 402) {
      throw new ProviderQuotaError('apollo', msg);
    }
    throw new ProviderRequestError('apollo', resp.status, msg);
  }

  return (json.people ?? []).map(toContact);
}

function toContact(p: ApolloPerson): Contact {
  const name = p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' ');
  return {
    name: name || 'Unknown',
    title: p.title ?? null,
    department: p.departments?.[0] ?? null,
    seniority: p.seniority ?? null,
    email: p.email ?? null,
    emailStatus: p.email_status ?? null,
    linkedinUrl: p.linkedin_url ?? null,
    source: 'apollo',
  };
}
