import type { Lead } from './types.js';
import { industryToTag, mapContactProperties } from './hubspot-map.js';

const API = 'https://api.hubapi.com';
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_500;

export interface PushArgs {
  token: string;
  leads: Lead[];
  industry?: string;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
}

export interface PushResult {
  created: number;
  skipped: number;
  failed: number;
  results: Array<{
    title: string;
    status: 'created' | 'exists' | 'failed';
    hubspotId?: string;
    error?: string;
  }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function listProperties(token: string, f: typeof fetch): Promise<Set<string>> {
  try {
    const res = await f(`${API}/crm/v3/properties/contacts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { results?: Array<{ name: string }> };
    return new Set((data.results ?? []).map((p) => p.name));
  } catch {
    return new Set();
  }
}

async function searchOne(
  token: string,
  property: string,
  value: string,
  f: typeof fetch,
): Promise<string | null> {
  if (!value) return null;
  try {
    const res = await f(`${API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }],
        limit: 1,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function findExisting(token: string, lead: Lead, f: typeof fetch): Promise<string | null> {
  const byEmail = lead.email ? await searchOne(token, 'email', lead.email, f) : null;
  if (byEmail) return byEmail;
  return lead.phone ? await searchOne(token, 'phone', lead.phone, f) : null;
}

async function createContact(
  token: string,
  properties: Record<string, string>,
  f: typeof fetch,
): Promise<{ id: string } | { error: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await f(`${API}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ properties }),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    const text = await res.text();
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { error: 'exhausted retries' };
}

export async function pushContacts(args: PushArgs): Promise<PushResult> {
  const f = args.fetchImpl ?? fetch;
  const existingProps = await listProperties(args.token, f);
  const typeContact =
    args.industry && existingProps.has('type_contact')
      ? industryToTag(args.industry).value
      : undefined;

  const result: PushResult = { created: 0, skipped: 0, failed: 0, results: [] };

  for (const lead of args.leads) {
    const existingId = await findExisting(args.token, lead, f);
    if (existingId) {
      result.skipped += 1;
      result.results.push({ title: lead.title, status: 'exists', hubspotId: existingId });
      continue;
    }

    const properties = mapContactProperties(lead, {
      industry: args.industry,
      existingProps,
      typeContactValue: typeContact,
    });

    if (args.dryRun) {
      result.created += 1;
      result.results.push({ title: lead.title, status: 'created' });
      continue;
    }

    const created = await createContact(args.token, properties, f);
    if ('id' in created) {
      result.created += 1;
      result.results.push({ title: lead.title, status: 'created', hubspotId: created.id });
    } else {
      result.failed += 1;
      result.results.push({ title: lead.title, status: 'failed', error: created.error });
    }
  }

  return result;
}
