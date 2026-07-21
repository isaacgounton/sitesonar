import { Lead } from '../types.js';
import type { DirectoryArgs, DirectorySource } from './registry.js';
import { usStateFrom, cityFrom } from './nppes.js';

/**
 * CMS Care Compare — the official registry of Medicare-certified healthcare
 * *facilities* (home health agencies, hospices, dialysis centers). A free
 * government JSON API, location-searchable by state + city, yielding facility
 * name + phone + address. Complements NPPES (individual providers) with the
 * agency/facility side. No email (yieldsEmail false) — call/mail leads.
 */
const API = 'https://data.cms.gov/provider-data/api/1/datastore/query';
const UA = 'sitesonar-leads/1.0 (+https://github.com/DAHO/sitesonar)';

// Industry keyword -> Care Compare dataset. They share one schema, so a single
// tolerant mapper handles them. ponytail: add nursing-home/hospital ids here.
const DATASETS: Record<string, { id: string; category: string }> = {
  'home health': { id: '6jpm-sxkc', category: 'Home Health Agency' },
  'home care': { id: '6jpm-sxkc', category: 'Home Health Agency' },
  hospice: { id: 'yc9t-dgbk', category: 'Hospice' },
  dialysis: { id: '23ew-n7w9', category: 'Dialysis Facility' },
};

export function datasetFor(industry: string): { id: string; category: string } | undefined {
  const i = industry.toLowerCase();
  for (const k of Object.keys(DATASETS).sort((a, b) => b.length - a.length)) {
    if (i.includes(k)) return DATASETS[k];
  }
  return undefined;
}

const pick = (row: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
};

const formatPhone = (p: string): string => {
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : p;
};

/** Convert one Care Compare row into a Lead, tolerating per-dataset key drift. */
export function rowToLead(row: Record<string, unknown>, category: string): Lead | null {
  const name = pick(row, ['provider_name', 'facility_name', 'name']);
  if (!name) return null;
  const lead: Lead = { title: name };
  const phone = pick(row, ['telephone_number', 'phone_number', 'phone']);
  if (phone) lead.phone = formatPhone(phone);
  const addr = [
    pick(row, ['address', 'address_line_1', 'provider_address']),
    pick(row, ['citytown', 'city_town', 'city']),
    pick(row, ['state', 'provider_state']),
  ]
    .filter(Boolean)
    .join(', ');
  if (addr) lead.address = addr;
  lead.category = category;
  return lead;
}

async function query(
  datasetId: string,
  conditions: Array<{ property: string; value: string; operator: string }>,
  max: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${API}/${datasetId}/0`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ conditions, limit: Math.min(Math.max(max, 1), 500) }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from data.cms.gov`);
  const data = (await res.json()) as { results?: Record<string, unknown>[] };
  return data.results ?? [];
}

async function scrape(args: DirectoryArgs): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const ds = datasetFor(args.industry);
  const state = usStateFrom(args.location);
  if (!ds || !state) {
    return {
      leads: [],
      warnings: ['cms-care-compare: needs a facility type (home health/hospice/dialysis) + US state'],
    };
  }
  const city = cityFrom(args.location);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const leads: Lead[] = [];
  try {
    const base = [{ property: 'state', value: state, operator: '=' }];
    let rows = await query(
      ds.id,
      city ? [...base, { property: 'citytown', value: city.toUpperCase(), operator: '=' }] : base,
      args.max,
      controller.signal,
    );
    // City names vary in CMS ("ST PETERSBURG" vs "SAINT PETERSBURG"); fall back
    // to state-wide rather than return nothing on a near-miss.
    if (rows.length === 0 && city) {
      warnings.push(`cms-care-compare: no ${ds.category} in ${city}, ${state} — widened to state`);
      rows = await query(ds.id, base, args.max, controller.signal);
    }
    for (const row of rows) {
      const lead = rowToLead(row, ds.category);
      if (lead) leads.push(lead);
      if (leads.length >= args.max) break;
    }
  } catch (err) {
    warnings.push(`cms-care-compare fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (leads.length === 0 && warnings.length === 0) {
    warnings.push(`cms-care-compare: no ${ds.category} found in ${state}`);
  }
  return { leads, warnings };
}

export const cmsCareCompare: DirectorySource = {
  id: 'cms-care-compare',
  label: 'CMS Care Compare — US Healthcare Facilities',
  sector: 'medical',
  specialties: ['home health', 'hospice', 'dialysis'],
  regions: ['US'],
  yieldsEmail: false,
  covers({ industry, location }) {
    return Boolean(datasetFor(industry)) && Boolean(usStateFrom(location));
  },
  scrape,
};
