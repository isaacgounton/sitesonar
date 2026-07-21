import { Lead } from '../types.js';
import type { DirectoryArgs, DirectorySource } from './registry.js';

/**
 * The Florida Bar "Find a Lawyer" directory — named attorneys with their
 * Bar-registered email, firm, and phone. Server-rendered HTML (no browser),
 * emails are Cloudflare-obfuscated in a `data-cfemail` hex attr (trivial XOR).
 * Ported from egbehavioral/automation/flbar.py, which fixed a 0-reply campaign
 * by targeting named people instead of firm-site `info@` gatekeeper inboxes.
 *
 * ponytail: yields email-ready contacts only — attorneys with no public Bar
 * email are skipped (the whole value is the email). Add a keep-nameless flag if
 * you ever want the names alone.
 */
const BASE_URL = 'https://www.floridabar.org/directories/find-mbr/';
const PAGE_SIZE = 50;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const FETCH_DELAY_MS = 1500; // polite to a government site

// Government lawyers (DOJ/DHS/USCIS/ICE) surface under the immigration filter
// but are opposing counsel, not referral sources — never email them.
const GOV_SUFFIXES = ['.gov', '.mil'];

// Industry keyword -> Florida Bar practice-area code. Unmapped legal terms fall
// through with no code = all attorneys in the city.
// ponytail: only immigration is verified; add codes as you confirm them.
const PRACTICE_CODES: Record<string, string> = {
  immigration: 'I01',
};

const BLOCK_RE = /<li class="profile-compact">.*?<\/li>/gs;
const NAME_RE = /<p class="profile-name">\s*<a[^>]*>([^<]+)<\/a>/;
const BAR_RE = /Bar #(\d+)/;
const CONTACT_RE = /<div class="profile-contact">(.*?)<\/div>/s;
const FIRST_P_RE = /<p>(.*?)<\/p>/s;
const TEL_RE = /tel:([0-9+\-() ]+)/;
const CFEMAIL_RE = /data-cfemail="([a-f0-9]+)"/;
const COUNT_RE = /of ([\d,]+) results/i;

/** Decode a Cloudflare `data-cfemail` hex string. First byte is the XOR key. */
export function decodeCfemail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

const clean = (t: string): string =>
  t
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface Attorney {
  name: string;
  barNum: string;
  firm: string;
  address: string;
  city: string;
  phone: string;
  email: string;
}

function parseContact(contactHtml: string): Omit<Attorney, 'name' | 'barNum'> {
  const out = { firm: '', address: '', city: '', phone: '', email: '' };

  const p = FIRST_P_RE.exec(contactHtml);
  if (p) {
    // First <p> is firm(optional) + street + "City, ST ZIP", <br>-separated.
    const parts = (p[1] ?? '')
      .split('<br>')
      .map(clean)
      .filter(Boolean);
    if (parts.length) {
      out.city = (parts[parts.length - 1] ?? '').split(',')[0]?.trim() ?? '';
      const rest = parts.slice(0, -1);
      // A firm line doesn't start with a street number / PO Box.
      if (rest.length && !/^(\d|PO Box|P\.O\.)/i.test(rest[0] ?? '')) {
        out.firm = rest[0] ?? '';
        out.address = rest.slice(1).join(' ');
      } else {
        out.address = rest.join(' ');
      }
    }
  }

  const tel = TEL_RE.exec(contactHtml);
  if (tel) out.phone = tel[1]!.trim();

  const cf = CFEMAIL_RE.exec(contactHtml);
  if (cf) out.email = decodeCfemail(cf[1]!);

  return out;
}

/** Parse a Find-a-Lawyer results page into attorney records. */
export function parseResults(html: string): Attorney[] {
  const out: Attorney[] = [];
  for (const block of html.match(BLOCK_RE) ?? []) {
    const nameM = NAME_RE.exec(block);
    const barM = BAR_RE.exec(block);
    const contactM = CONTACT_RE.exec(block);
    const contact = contactM ? parseContact(contactM[1]!) : { firm: '', address: '', city: '', phone: '', email: '' };
    out.push({
      name: nameM ? clean(nameM[1]!) : '',
      barNum: barM ? barM[1]! : '',
      ...contact,
    });
  }
  return out;
}

/** Total result count reported on the page (0 if absent). */
export function totalCount(html: string): number {
  const m = COUNT_RE.exec(html);
  return m ? parseInt(m[1]!.replace(/,/g, ''), 10) : 0;
}

/** Convert an attorney record into a Lead, or null if unusable (no name/email). */
export function toLead(a: Attorney): Lead | null {
  if (!a.name.trim()) return null;
  const email = a.email.trim();
  if (!email) return null; // email-ready contacts only
  if (GOV_SUFFIXES.some((s) => email.toLowerCase().endsWith(s))) return null;

  const lead: Lead = { title: a.firm.trim() || a.name.trim() };
  lead.contactName = a.name.trim();
  lead.email = email;
  lead.emailConfidence = 'scraped';
  if (a.phone) lead.phone = a.phone;
  const addr = [a.address, a.city].map((s) => s.trim()).filter(Boolean).join(', ');
  if (addr) lead.address = addr;
  lead.category = 'Attorney';
  return lead;
}

function practiceCode(industry: string): string | undefined {
  const i = industry.toLowerCase();
  for (const [k, v] of Object.entries(PRACTICE_CODES)) if (i.includes(k)) return v;
  return undefined;
}

async function fetchPage(
  city: string,
  page: number,
  code: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    locType: 'C',
    locValue: city,
    sdx: 'N',
    eligible: 'N',
    deceased: 'N',
    pageNumber: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (code) params.set('pracAreas', code);
  const res = await fetch(`${BASE_URL}?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from floridabar.org`);
  return res.text();
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

async function scrape(args: DirectoryArgs): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const city = args.location.split(',')[0]?.trim() ?? '';
  if (!city || /^(fl|florida)$/i.test(city)) {
    return { leads: [], warnings: ['florida-bar: need a Florida city (e.g. "Tampa, FL")'] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const code = practiceCode(args.industry);
  const leads: Lead[] = [];
  const seen = new Set<string>();

  try {
    const first = await fetchPage(city, 1, code, controller.signal);
    const total = totalCount(first);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    for (let page = 1; page <= totalPages && leads.length < args.max; page++) {
      const html = page === 1 ? first : (await sleep(FETCH_DELAY_MS, controller.signal), await fetchPage(city, page, code, controller.signal));
      for (const a of parseResults(html)) {
        const lead = toLead(a);
        if (!lead) continue;
        const key = a.barNum || lead.email!.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        leads.push(lead);
        if (leads.length >= args.max) break;
      }
    }
  } catch (err) {
    warnings.push(`florida-bar fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (leads.length === 0 && !warnings.length) {
    warnings.push(`florida-bar: no attorneys with a public email in ${city}`);
  }
  return { leads, warnings };
}

export const floridaBar: DirectorySource = {
  id: 'florida-bar',
  label: 'The Florida Bar — Find a Lawyer',
  sector: 'legal',
  specialties: ['immigration'],
  regions: ['US-FL'],
  yieldsEmail: true,
  covers({ industry, location }) {
    const legal = /lawyer|attorney|legal|law firm|counsel|immigration/i.test(industry);
    const fl = /\bfl\b|florida/i.test(location);
    return legal && fl;
  },
  scrape,
};
