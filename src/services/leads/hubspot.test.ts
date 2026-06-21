import { describe, it, expect, vi } from 'vitest';
import { pushContacts } from './hubspot.js';
import type { Lead } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const lead: Lead = { title: 'Acme Law', email: 'info@acmelaw.com', phone: '(212) 555-0188' };

describe('pushContacts', () => {
  it('creates a new contact when none exists', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) return jsonResponse({ id: '999' }, 201);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.created).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'created', hubspotId: '999' });
  });

  it('skips a contact that already exists (dedup by email)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [{ id: '111' }] });
      return jsonResponse({}, 500); // create must NOT be called
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'exists', hubspotId: '111' });
  });

  it('dryRun does not call the create endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      return jsonResponse({}, 500);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: true, fetchImpl });
    expect(result.created).toBe(1); // reported as would-create
    expect(calls.some((c) => c.includes('/objects/contacts') && !c.includes('search'))).toBe(false);
  });

  it('counts a failed lead and continues the batch', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) return jsonResponse({ message: 'bad' }, 400);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const leads = [lead, { title: 'Beta Corp', email: 'beta@beta.com', phone: '' }];
    const result = await pushContacts({ token: 'pat-x', leads, dryRun: false, fetchImpl });
    expect(result.failed).toBe(2);
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
    expect(result.results[0]!.error).toBeTruthy();
  });
});
