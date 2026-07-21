import { Lead } from '../types.js';
import { floridaBar } from './florida-bar.js';
import { nppesNpi } from './nppes.js';
import { cmsCareCompare } from './cms.js';

/**
 * Directory sources: bespoke scrapers for public professional directories (bar
 * registries, medical boards, trade associations, ...). Unlike Maps/OSM — which
 * return *businesses* for any industry+location — a directory covers a specific
 * sector and region, and typically yields *named people with real emails*
 * (already email-ready, no /enrich needed). That makes them the highest-quality
 * contact source when one matches.
 *
 * Adding a directory is drop-a-file: implement `DirectorySource`, register it in
 * DIRECTORIES below. It self-declares its category (sector/specialties/regions)
 * for browsing (GET /v1/leads/directories) and owns its own `covers()` match
 * logic, so the registry stays a dumb list.
 */
export interface DirectoryArgs {
  industry: string;
  location: string;
  max: number;
  timeoutMs: number;
}

export interface DirectorySource {
  /** Stable slug, e.g. 'florida-bar'. */
  id: string;
  /** Human label, e.g. 'The Florida Bar — Find a Lawyer'. */
  label: string;
  /** Coarse browse category: 'legal' | 'medical' | 'home-services' | 'finance' | ... */
  sector: string;
  /** Fine sub-verticals it can target (informational), e.g. ['immigration']. */
  specialties?: string[];
  /** Coverage tags, e.g. ['US-FL']. Empty = national/broad. */
  regions: string[];
  /** True when leads arrive with a real email (email-ready) — /enrich can skip them. */
  yieldsEmail: boolean;
  /** Does this directory cover the given industry + location? Owns its own logic. */
  covers(q: { industry: string; location: string }): boolean;
  /** Run it. Returns leads in the shared shape. */
  scrape(args: DirectoryArgs): Promise<{ leads: Lead[]; warnings: string[] }>;
}

export const DIRECTORIES: DirectorySource[] = [floridaBar, nppesNpi, cmsCareCompare];

/** Directories whose coverage matches this query (usually 0 or 1). */
export function matchDirectories(q: { industry: string; location: string }): DirectorySource[] {
  return DIRECTORIES.filter((d) => d.covers(q));
}

/** Public metadata for GET /v1/leads/directories — the browsable catalogue. */
export function listDirectories(): Array<Omit<DirectorySource, 'covers' | 'scrape'>> {
  return DIRECTORIES.map(({ id, label, sector, specialties, regions, yieldsEmail }) => ({
    id,
    label,
    sector,
    specialties,
    regions,
    yieldsEmail,
  }));
}

/**
 * Append `extra` onto `primary`, keyed by email (else contactName|title), up to
 * `max`. Unlike mergeByTitle, this does NOT dedupe on firm name — so several
 * named people at one firm, and a firm's own business listing, all coexist.
 */
export function mergeContacts(primary: Lead[], extra: Lead[], max: number): Lead[] {
  const key = (l: Lead): string =>
    l.email?.toLowerCase().trim() ||
    `${(l.contactName ?? '').toLowerCase().trim()}|${l.title.toLowerCase().trim()}`;
  const seen = new Set(primary.map(key));
  const out = [...primary];
  for (const l of extra) {
    if (out.length >= max) break;
    const k = key(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, max);
}

/** Run every matching directory, merging their leads. Never throws. */
export async function runDirectories(
  args: DirectoryArgs,
): Promise<{ leads: Lead[]; warnings: string[]; ran: string[] }> {
  const matched = matchDirectories(args);
  const warnings: string[] = [];
  let leads: Lead[] = [];
  for (const d of matched) {
    try {
      const r = await d.scrape(args);
      leads = mergeContacts(leads, r.leads, args.max);
      warnings.push(...r.warnings);
    } catch (err) {
      warnings.push(`directory ${d.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { leads, warnings, ran: matched.map((d) => d.id) };
}
