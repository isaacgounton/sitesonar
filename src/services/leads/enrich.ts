import { resolveMx as nodeResolveMx } from 'node:dns/promises';
import type { BrowserPool } from '../../browser.js';
import { Lead } from './types.js';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  bestEmail,
  candidateUrls,
  extractMeta,
} from './enrich-extract.js';

const GUESS_PREFIXES = ['info', 'contact', 'hello', 'office'];

export async function guessEmail(
  domain: string,
  opts: { verifyMx: boolean; resolveMx?: typeof nodeResolveMx },
): Promise<string> {
  const root = domain.replace(/^www\./i, '').toLowerCase();
  if (opts.verifyMx) {
    const resolver = opts.resolveMx ?? nodeResolveMx;
    try {
      const records = await resolver(root);
      if (!records || records.length === 0) return '';
    } catch {
      return '';
    }
  }
  return `${GUESS_PREFIXES[0]}@${root}`;
}

function domainFromWebsite(website: string): string {
  try {
    return new URL(website).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

async function fetchStatic(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; sitesonar-leads/1.0)' },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

async function fetchHeadless(browser: BrowserPool, url: string, timeoutMs: number): Promise<string> {
  const context = await browser.acquire();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return await page.content();
  } catch {
    return '';
  } finally {
    await browser.release(context);
  }
}

export interface EnrichArgs {
  browser: BrowserPool;
  leads: Lead[];
  guessEmails: boolean;
  verifyMx: boolean;
  headlessFallback: boolean;
  concurrency: number;
  timeoutMs: number;
}

async function enrichOne(lead: Lead, args: EnrichArgs, warnings: string[]): Promise<Lead> {
  if (!lead.website) {
    warnings.push(`${lead.title}: no website to enrich`);
    return lead;
  }
  const domain = domainFromWebsite(lead.website);
  if (!domain) {
    warnings.push(`${lead.title}: unparseable website ${lead.website}`);
    return lead;
  }
  const deadline = Date.now() + args.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const base = `https://${domain}`;
  const out: Lead = { ...lead };
  const emails: string[] = [];

  const homepage = await fetchStatic(base, Math.min(10_000, remaining()));
  const urls = candidateUrls(base, homepage, 5);
  const htmls: Record<string, string> = homepage ? { [base]: homepage } : {};

  for (const url of urls) {
    if (Date.now() > deadline) break;
    const html = htmls[url] ?? (await fetchStatic(url, Math.min(10_000, remaining())));
    if (!html) continue;
    applyMeta(out, html);
    applySocials(out, html);
    emails.push(...extractEmails(html));
    if (!out.phone) {
      const phones = extractPhones(html);
      if (phones.length) out.phone = phones[0];
    }
    if (emails.length) break;
  }

  if (emails.length === 0 && args.headlessFallback) {
    for (const url of urls.slice(0, 2)) {
      if (Date.now() > deadline) break;
      const html = await fetchHeadless(args.browser, url, Math.min(12_000, remaining()));
      if (!html) continue;
      applyMeta(out, html);
      applySocials(out, html);
      emails.push(...extractEmails(html));
      if (emails.length) break;
    }
  }

  if (emails.length) {
    out.email = bestEmail(emails, domain);
    out.emailConfidence = 'scraped';
  } else if (args.guessEmails && Date.now() < deadline) {
    const guessed = await guessEmail(domain, { verifyMx: args.verifyMx });
    if (guessed) {
      out.email = guessed;
      out.emailConfidence = 'guessed';
    } else {
      warnings.push(`${domain}: no email found`);
    }
  } else {
    warnings.push(`${domain}: no email found`);
  }
  return out;
}

function applyMeta(lead: Lead, html: string): void {
  const meta = extractMeta(html);
  if (!lead.description && meta.description) lead.description = meta.description;
}

function applySocials(lead: Lead, html: string): void {
  const s = extractSocialLinks(html);
  if (!lead.linkedin && s.linkedin) lead.linkedin = s.linkedin;
  if (!lead.facebook && s.facebook) lead.facebook = s.facebook;
  if (!lead.instagram && s.instagram) lead.instagram = s.instagram;
}

export async function enrichLeads(
  args: EnrichArgs,
): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: Lead[] = new Array(args.leads.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < args.leads.length) {
      const i = cursor++;
      out[i] = await enrichOne(args.leads[i]!, args, warnings);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(args.concurrency, args.leads.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return { leads: out, warnings };
}
