import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  bestEmail,
  candidateUrls,
  extractMeta,
} from './enrich-extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  resolve(here, '../../../test/fixtures/leads/contact-page.html'),
  'utf8',
);

describe('extractEmails', () => {
  it('finds mailto and inline emails, deduped', () => {
    const emails = extractEmails(html);
    expect(emails).toContain('info@acmelaw.com');
    expect(emails).toContain('partners@acmelaw.com');
    expect(new Set(emails).size).toBe(emails.length);
  });
});

describe('extractPhones', () => {
  it('finds a phone number', () => {
    expect(extractPhones(html)).toContain('(212) 555-0188');
  });
});

describe('extractSocialLinks', () => {
  it('captures linkedin/facebook, ignores twitter', () => {
    const s = extractSocialLinks(html);
    expect(s.linkedin).toBe('https://www.linkedin.com/company/acme-law');
    expect(s.facebook).toBe('https://www.facebook.com/acmelaw');
    expect(s.instagram).toBeUndefined();
  });
});

describe('bestEmail', () => {
  it('prefers an on-domain email over a generic one', () => {
    expect(bestEmail(['x@gmail.com', 'info@acmelaw.com'], 'acmelaw.com')).toBe('info@acmelaw.com');
  });
  it('returns first when none match domain', () => {
    expect(bestEmail(['a@x.com', 'b@y.com'], 'acmelaw.com')).toBe('a@x.com');
  });
  it('returns empty for no emails', () => {
    expect(bestEmail([], 'acmelaw.com')).toBe('');
  });
});

describe('candidateUrls', () => {
  it('prioritizes contact/about pages discovered on the homepage', () => {
    const urls = candidateUrls('https://acmelaw.com', html, 5);
    expect(urls[0]).toBe('https://acmelaw.com');
    expect(urls).toContain('https://acmelaw.com/contact');
    expect(urls).toContain('https://acmelaw.com/about-us');
    expect(urls.length).toBeLessThanOrEqual(5);
  });
});

describe('extractMeta', () => {
  it('reads og:site_name and description', () => {
    const meta = extractMeta(html);
    expect(meta.name).toBe('Acme Law');
    expect(meta.description).toBe('Immigration lawyers in New York.');
  });
});
