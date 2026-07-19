import { Lead } from './types.js';

/**
 * Free, TOS-clean lead source: OpenStreetMap via the Overpass API. Given an
 * industry + location it returns businesses (name, website, phone, address,
 * category, and any published email/socials) in the same `Lead[]` shape as the
 * Maps scraper, so /enrich and /hubspot consume it unchanged. No key, no login,
 * no browser — just two HTTP calls (Nominatim to resolve the area, Overpass to
 * query it).
 */

// The canonical instance is frequently overloaded (504s) or hangs, so we fall
// back across public mirrors in order until one answers. A per-request
// `overpassUrl` overrides the whole list.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Cap on any single endpoint attempt so one hanging mirror can't eat the budget.
const PER_ATTEMPT_MS = 45_000;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires an identifying User-Agent.
const UA = 'sitesonar-leads/1.0 (+https://github.com/DAHO/sitesonar)';

/**
 * Common local-business industries → OSM tag filters (bracket bodies). Covers
 * what lead-gen users actually search; anything unlisted falls back to a fuzzy
 * regex match across the main business keys (see industryFilters).
 */
const INDUSTRY_TAGS: Record<string, string[]> = {
  restaurant: ['amenity=restaurant'],
  cafe: ['amenity=cafe'],
  coffee: ['amenity=cafe'],
  bar: ['amenity=bar', 'amenity=pub'],
  pub: ['amenity=bar', 'amenity=pub'],
  bakery: ['shop=bakery'],
  hairdresser: ['shop=hairdresser', 'shop=beauty'],
  'hair salon': ['shop=hairdresser', 'shop=beauty'],
  salon: ['shop=hairdresser', 'shop=beauty'],
  barber: ['shop=hairdresser'],
  beauty: ['shop=beauty', 'shop=massage'],
  spa: ['leisure=spa', 'shop=beauty', 'shop=massage'],
  dentist: ['amenity=dentist', 'healthcare=dentist'],
  doctor: ['amenity=doctors', 'healthcare=doctor'],
  clinic: ['amenity=clinic', 'amenity=doctors', 'healthcare=clinic'],
  pharmacy: ['amenity=pharmacy'],
  veterinary: ['amenity=veterinary'],
  vet: ['amenity=veterinary'],
  lawyer: ['office=lawyer'],
  attorney: ['office=lawyer'],
  accountant: ['office=accountant'],
  accounting: ['office=accountant'],
  insurance: ['office=insurance'],
  'real estate': ['office=estate_agent'],
  realtor: ['office=estate_agent'],
  plumber: ['craft=plumber'],
  electrician: ['craft=electrician'],
  gym: ['leisure=fitness_centre', 'leisure=sports_centre'],
  fitness: ['leisure=fitness_centre', 'leisure=sports_centre'],
  hotel: ['tourism=hotel'],
  florist: ['shop=florist'],
  mechanic: ['shop=car_repair'],
  garage: ['shop=car_repair'],
  'car repair': ['shop=car_repair'],
  supermarket: ['shop=supermarket'],
  grocery: ['shop=supermarket', 'shop=convenience'],
  clothing: ['shop=clothes'],
  clothes: ['shop=clothes'],
};

const escapeRe = (s: string): string => s.replace(/["\\]/g, '\\$&');

/** Map an industry string to OSM Overpass tag-filter bodies. */
export function industryFilters(industry: string): string[] {
  const norm = industry.trim().toLowerCase();
  const mapped = INDUSTRY_TAGS[norm] ?? INDUSTRY_TAGS[norm.split(' ')[0] ?? ''];
  if (mapped) return mapped;
  // Fallback: fuzzy, case-insensitive match of the term across the main
  // business keys. Won't catch every phrasing, but beats returning nothing.
  const term = escapeRe(norm);
  return ['shop', 'amenity', 'craft', 'office', 'tourism', 'leisure', 'healthcare'].map(
    (k) => `${k}~"${term}",i`,
  );
}

/** Build the Overpass QL for an already-resolved area id. */
export function buildOverpassQuery(opts: {
  industry: string;
  areaId: number;
  max: number;
  timeoutSec: number;
}): string {
  const filters = industryFilters(opts.industry)
    .map((f) => `  nwr[${f}](area.a);`)
    .join('\n');
  return [
    `[out:json][timeout:${opts.timeoutSec}];`,
    `area(${opts.areaId})->.a;`,
    `(`,
    filters,
    `);`,
    `out center tags ${opts.max};`,
  ].join('\n');
}

interface OsmElement {
  tags?: Record<string, string>;
}

const CATEGORY_KEYS = ['shop', 'amenity', 'craft', 'office', 'tourism', 'leisure', 'healthcare'];

/** Ensure a website tag is a crawlable absolute URL (enrich does `new URL()`). */
function normalizeWebsite(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Convert one OSM element into a Lead, or null if it has no name. */
export function elementToLead(el: OsmElement): Lead | null {
  const t = el.tags ?? {};
  const name = t.name ?? t['name:en'] ?? '';
  if (!name.trim()) return null;

  const addr = [
    [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
    t['addr:city'],
    t['addr:postcode'],
  ]
    .filter(Boolean)
    .join(', ');

  const catKey = CATEGORY_KEYS.find((k) => t[k]);
  const category = catKey ? `${t[catKey]}`.replace(/_/g, ' ') : undefined;

  const lead: Lead = { title: name.trim() };
  const website = normalizeWebsite(t.website ?? t['contact:website'] ?? t.url);
  if (website) lead.website = website;
  const phone = t.phone ?? t['contact:phone'] ?? t['contact:mobile'];
  if (phone) lead.phone = phone.trim();
  if (addr) lead.address = addr;
  if (category) lead.category = category;
  const email = t.email ?? t['contact:email'];
  if (email) {
    lead.email = email.trim();
    lead.emailConfidence = 'scraped';
  }
  if (t['contact:linkedin']) lead.linkedin = t['contact:linkedin'];
  if (t['contact:facebook']) lead.facebook = t['contact:facebook'];
  if (t['contact:instagram']) lead.instagram = t['contact:instagram'];
  return lead;
}

const normTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Append `extra` leads onto `primary`, skipping any whose name already appears
 * in primary, up to `max`. Used to top up Google Maps results with OSM ones —
 * primary (Maps) wins on collision because it carries rating/reviews/map link.
 */
export function mergeByTitle(primary: Lead[], extra: Lead[], max: number): Lead[] {
  const seen = new Set(primary.map((l) => normTitle(l.title)));
  const out = [...primary];
  for (const l of extra) {
    if (out.length >= max) break;
    const key = normTitle(l.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out.slice(0, max);
}

/** Drop duplicates by name + address (OSM often has a node and a way for one place). */
export function dedupeLeads(leads: Lead[]): Lead[] {
  const seen = new Set<string>();
  const out: Lead[] = [];
  for (const l of leads) {
    const key = `${l.title.toLowerCase()}|${(l.address ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

async function fetchJson(url: string, signal: AbortSignal, body?: string): Promise<unknown> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/**
 * POST the query to each endpoint in turn until one answers, bounding every
 * attempt by both the overall deadline and PER_ATTEMPT_MS. Aborting one hung
 * mirror falls through to the next.
 */
async function queryOverpass(
  endpoints: string[],
  query: string,
  deadline: number,
  warnings: string[],
): Promise<{ elements?: OsmElement[] }> {
  let lastErr: unknown;
  for (const url of endpoints) {
    const budget = Math.min(PER_ATTEMPT_MS, deadline - Date.now());
    if (budget <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      return (await fetchJson(url, controller.signal, `data=${encodeURIComponent(query)}`)) as {
        elements?: OsmElement[];
      };
    } catch (err) {
      lastErr = err;
      warnings.push(`overpass ${new URL(url).host} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`all Overpass endpoints failed (last: ${lastErr instanceof Error ? lastErr.message : lastErr})`);
}

/**
 * Resolve a place name to an Overpass area id via Nominatim. Area id encoding:
 * relations add 3.6e9, ways add 2.4e9 to the OSM id (Overpass convention).
 */
async function geocodeArea(location: string, signal: AbortSignal): Promise<number> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const results = (await fetchJson(url, signal)) as Array<{
    osm_type?: string;
    osm_id?: number;
  }>;
  const hit = results[0];
  if (!hit?.osm_id || !hit.osm_type) {
    throw new Error(`Nominatim found no area for "${location}"`);
  }
  if (hit.osm_type === 'relation') return 3_600_000_000 + hit.osm_id;
  if (hit.osm_type === 'way') return 2_400_000_000 + hit.osm_id;
  throw new Error(`"${location}" resolved to a point, not an area — use a broader location`);
}

export interface OverpassArgs {
  industry: string;
  location: string;
  max: number;
  timeoutMs: number;
  overpassUrl?: string;
}

export async function scrapeOverpass(
  args: OverpassArgs,
): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const deadline = Date.now() + args.timeoutMs;

  // Geocode the area first, on its own bounded slice.
  const geoController = new AbortController();
  const geoTimer = setTimeout(() => geoController.abort(), Math.min(15_000, args.timeoutMs));
  let areaId: number;
  try {
    areaId = await geocodeArea(args.location, geoController.signal);
  } finally {
    clearTimeout(geoTimer);
  }

  // Overpass's own timeout is in whole seconds; keep it under the per-attempt cap.
  const timeoutSec = Math.max(5, Math.floor(PER_ATTEMPT_MS / 1000) - 5);
  const query = buildOverpassQuery({ industry: args.industry, areaId, max: args.max, timeoutSec });
  const endpoints = args.overpassUrl ? [args.overpassUrl] : OVERPASS_ENDPOINTS;
  const data = await queryOverpass(endpoints, query, deadline, warnings);

  const leads = dedupeLeads(
    (data.elements ?? []).map(elementToLead).filter((l): l is Lead => l !== null),
  ).slice(0, args.max);
  if (leads.length === 0) {
    warnings.push('OSM returned no named businesses for this industry/location');
  }
  return { leads, warnings };
}
