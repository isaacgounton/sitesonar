import { describe, it, expect } from 'vitest';
import { matchDirectories, mergeContacts, listDirectories } from './registry.js';
import type { Lead } from '../types.js';

describe('matchDirectories', () => {
  it('returns Florida Bar for immigration lawyers in FL', () => {
    expect(matchDirectories({ industry: 'immigration lawyer', location: 'Tampa, FL' }).map((d) => d.id)).toContain(
      'florida-bar',
    );
  });
  it('returns nothing for an unrelated query', () => {
    expect(matchDirectories({ industry: 'bakery', location: 'Lyon' })).toHaveLength(0);
  });
});

describe('listDirectories', () => {
  it('exposes browsable category metadata without the runtime fns', () => {
    const d = listDirectories().find((x) => x.id === 'florida-bar')!;
    expect(d).toMatchObject({ sector: 'legal', regions: ['US-FL'], yieldsEmail: true });
    expect(d).not.toHaveProperty('scrape');
  });
});

describe('mergeContacts', () => {
  it('keeps multiple named people at the same firm (dedupe by email, not title)', () => {
    const dir: Lead[] = [
      { title: 'Doe Law', contactName: 'Jane Doe', email: 'jane@doe.com' },
      { title: 'Doe Law', contactName: 'John Doe', email: 'john@doe.com' },
    ];
    const out = mergeContacts([], dir, 20);
    expect(out).toHaveLength(2);
  });
  it('keeps a Maps firm listing and a directory person at that firm side by side', () => {
    const maps: Lead[] = [{ title: 'Doe Law' }]; // business, no email
    const dir: Lead[] = [{ title: 'Doe Law', contactName: 'Jane Doe', email: 'jane@doe.com' }];
    expect(mergeContacts(maps, dir, 20)).toHaveLength(2);
  });
  it('dedupes by email and respects max', () => {
    const primary: Lead[] = [{ title: 'X', email: 'a@x.com' }];
    const extra: Lead[] = [{ title: 'Y', email: 'A@X.com' }, { title: 'Z', email: 'b@z.com' }];
    expect(mergeContacts(primary, extra, 2)).toHaveLength(2); // dup email dropped, capped at 2
  });
});
