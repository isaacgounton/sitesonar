import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRobots } from './robots.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, '../../test/fixtures/robots', name), 'utf8');

describe('parseRobots', () => {
  it('parses basic robots.txt', () => {
    const result = parseRobots(fixture('basic.txt'), 'https://example.com/robots.txt');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.userAgent).toBe('*');
    expect(result.rules[0]!.disallow).toEqual(['/admin/', '/api/']);
    expect(result.rules[0]!.allow).toEqual(['/api/public/']);
    expect(result.rules[0]!.crawlDelay).toBe(1);
    expect(result.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('picks the matching user-agent block when effectiveUserAgent provided', () => {
    const result = parseRobots(
      fixture('multi-ua.txt'),
      'https://example.com/robots.txt',
      'Googlebot/2.1',
    );
    expect(result.effectiveRules?.userAgent).toBe('Googlebot/2.1');
    expect(result.effectiveRules?.allow).toEqual(['/']);
  });

  it('falls back to wildcard rule when no UA matches', () => {
    const result = parseRobots(
      fixture('multi-ua.txt'),
      'https://example.com/robots.txt',
      'UnknownBot/1.0',
    );
    expect(result.effectiveRules?.disallow).toEqual(['/']);
  });

  it('extracts multiple sitemap URLs', () => {
    const result = parseRobots(fixture('multi-ua.txt'), 'https://example.com/robots.txt');
    expect(result.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news-sitemap.xml',
    ]);
  });
});
