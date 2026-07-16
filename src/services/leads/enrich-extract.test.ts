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
  isJunkEmail,
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

  it('drops bot/placeholder addresses (Sentry/Wix hashes, no-reply, example)', () => {
    const page = `
      <a href="mailto:605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com">hash</a>
      <a href="mailto:no-reply@acmelaw.com">noreply</a>
      Contact hello@acmelaw.com or test@example.com
    `;
    const emails = extractEmails(page);
    expect(emails).toContain('hello@acmelaw.com');
    expect(emails).not.toContain('605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com');
    expect(emails).not.toContain('no-reply@acmelaw.com');
    expect(emails).not.toContain('test@example.com');
  });

  it('isJunkEmail keeps real addresses, rejects placeholders', () => {
    expect(isJunkEmail('info@acmelaw.com')).toBe(false);
    expect(isJunkEmail('605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com')).toBe(true);
    expect(isJunkEmail('logo@brand.png')).toBe(true);
    expect(isJunkEmail('noreply@wix.com')).toBe(true);
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

  it('prefers a profile over a post/reel link', () => {
    const page = `
      <a href="https://www.instagram.com/p/DRvgHjhjHaS/?img_index=1">a post</a>
      <a href="https://www.instagram.com/epochcoffee">profile</a>
      <a href="https://www.facebook.com/reel/123456">a reel</a>
      <a href="https://www.facebook.com/epochcoffee/">page</a>
    `;
    const s = extractSocialLinks(page);
    expect(s.instagram).toBe('https://www.instagram.com/epochcoffee');
    expect(s.facebook).toBe('https://www.facebook.com/epochcoffee/');
  });

  it('falls back to a post link when no profile is present', () => {
    const page = '<a href="https://www.instagram.com/p/DRvgHjhjHaS/">only a post</a>';
    expect(extractSocialLinks(page).instagram).toBe('https://www.instagram.com/p/DRvgHjhjHaS/');
  });

  it('skips share/login junk links', () => {
    const page = `
      <a href="https://www.facebook.com/sharer/sharer.php?u=https://x.com">share</a>
      <a href="https://www.facebook.com/login.php?next=x">login</a>
    `;
    expect(extractSocialLinks(page).facebook).toBeUndefined();
  });

  it('prefers a linkedin company page over a personal profile', () => {
    const page = `
      <a href="https://www.linkedin.com/in/jane-doe">person</a>
      <a href="https://www.linkedin.com/company/acme">company</a>
    `;
    expect(extractSocialLinks(page).linkedin).toBe('https://www.linkedin.com/company/acme');
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
