import { describe, it, expect } from 'vitest';
import {
  industryFilters,
  buildOverpassQuery,
  elementToLead,
  dedupeLeads,
  mergeByTitle,
} from './overpass.js';

describe('industryFilters', () => {
  it('maps a known industry to OSM tags', () => {
    expect(industryFilters('Hairdresser')).toContain('shop=hairdresser');
  });
  it('matches on the first word', () => {
    expect(industryFilters('coffee shop')).toContain('amenity=cafe');
  });
  it('falls back to a fuzzy regex across business keys', () => {
    const f = industryFilters('locksmith');
    expect(f).toContain('shop~"locksmith",i');
    expect(f).toContain('craft~"locksmith",i');
  });
});

describe('buildOverpassQuery', () => {
  it('wraps filters in an area query with the given limit', () => {
    const q = buildOverpassQuery({ industry: 'bakery', areaId: 3_600_012_345, max: 30, timeoutSec: 25 });
    expect(q).toContain('[out:json][timeout:25]');
    expect(q).toContain('area(3600012345)->.a;');
    expect(q).toContain('nwr[shop=bakery](area.a);');
    expect(q).toContain('out center tags 30;');
  });
});

describe('elementToLead', () => {
  it('maps tags to a Lead and makes bare websites absolute', () => {
    const lead = elementToLead({
      tags: {
        name: 'Chez Paul',
        'addr:housenumber': '12',
        'addr:street': 'Rue de la Paix',
        'addr:city': 'Lyon',
        'addr:postcode': '69001',
        website: 'chezpaul.fr',
        phone: '+33 4 11 22 33 44',
        amenity: 'restaurant',
        'contact:email': 'hi@chezpaul.fr',
        'contact:instagram': 'https://instagram.com/chezpaul',
      },
    });
    expect(lead).toMatchObject({
      title: 'Chez Paul',
      website: 'https://chezpaul.fr',
      phone: '+33 4 11 22 33 44',
      address: '12 Rue de la Paix, Lyon, 69001',
      category: 'restaurant',
      email: 'hi@chezpaul.fr',
      emailConfidence: 'scraped',
      instagram: 'https://instagram.com/chezpaul',
    });
  });
  it('keeps an already-absolute website untouched', () => {
    expect(elementToLead({ tags: { name: 'X', website: 'http://x.com' } })?.website).toBe('http://x.com');
  });
  it('returns null when there is no name', () => {
    expect(elementToLead({ tags: { shop: 'bakery' } })).toBeNull();
  });
});

describe('mergeByTitle', () => {
  it('tops up primary with unseen names up to max, primary kept on collision', () => {
    const maps = [{ title: 'Maison Mathieu', rating: 4.6 }];
    const osm = [{ title: 'maison  mathieu' }, { title: 'Chez Paul' }, { title: 'Le Fournil' }];
    const out = mergeByTitle(maps, osm, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Maison Mathieu', rating: 4.6 }); // Maps wins the dup
    expect(out[1]?.title).toBe('Chez Paul');
  });
  it('is a no-op when primary already fills max', () => {
    const maps = [{ title: 'A' }, { title: 'B' }];
    expect(mergeByTitle(maps, [{ title: 'C' }], 2)).toHaveLength(2);
  });
});

describe('dedupeLeads', () => {
  it('drops duplicates by name + address', () => {
    const out = dedupeLeads([
      { title: 'A', address: '1 St' },
      { title: 'A', address: '1 St' },
      { title: 'A', address: '2 Ave' },
    ]);
    expect(out).toHaveLength(2);
  });
});
