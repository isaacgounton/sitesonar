import * as cheerio from 'cheerio';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+\d{1,2}\s)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;

// Image/asset emails that are never real contacts.
const EMAIL_JUNK = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const $ = cheerio.load(html);
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = (($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0] ?? '').trim();
    if (addr) found.add(addr.toLowerCase());
  });
  for (const m of html.matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    if (!EMAIL_JUNK.test(addr)) found.add(addr);
  }
  return [...found];
}

export function extractPhones(html: string): string[] {
  const text = cheerio.load(html).text();
  const found = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) found.add(m[0].trim());
  return [...found];
}

const SOCIAL_HOSTS: Array<[keyof SocialLinks, RegExp]> = [
  ['linkedin', /linkedin\.com/i],
  ['facebook', /facebook\.com/i],
  ['instagram', /instagram\.com/i],
];

interface SocialLinks {
  linkedin?: string;
  facebook?: string;
  instagram?: string;
}

export function extractSocialLinks(html: string): SocialLinks {
  const $ = cheerio.load(html);
  const out: SocialLinks = {};
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    for (const [key, re] of SOCIAL_HOSTS) {
      if (!re.test(href)) continue;
      const current = out[key];
      // Upgrade a personal LinkedIn to a company page if found later.
      if (!current || (key === 'linkedin' && /\/company\//.test(href) && !/\/company\//.test(current))) {
        out[key] = href;
      }
    }
  });
  return out;
}

export function bestEmail(emails: string[], domain: string): string {
  if (emails.length === 0) return '';
  const root = domain.replace(/^www\./i, '').toLowerCase();
  const onDomain = emails.find((e) => e.toLowerCase().endsWith(`@${root}`));
  return onDomain ?? emails[0]!;
}

const PRIORITY_PATHS = ['contact', 'contact-us', 'about', 'about-us', 'team'];

export function candidateUrls(base: string, homepageHtml: string, maxPages: number): string[] {
  const urls: string[] = [base];
  const seen = new Set([base]);
  const $ = cheerio.load(homepageHtml);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    let abs: string;
    try {
      abs = new URL(href, base).toString().replace(/#.*$/, '');
    } catch {
      return;
    }
    if (new URL(abs).host !== new URL(base).host) return;
    links.push(abs);
  });
  // Prioritize contact/about-style pages.
  const ranked = [...links].sort((a, b) => pathRank(a) - pathRank(b));
  for (const u of ranked) {
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= maxPages) break;
  }
  return urls.slice(0, maxPages);
}

function pathRank(url: string): number {
  const path = url.toLowerCase();
  const i = PRIORITY_PATHS.findIndex((p) => path.includes(p));
  return i === -1 ? PRIORITY_PATHS.length : i;
}

export function extractMeta(html: string): { name?: string; description?: string } {
  const $ = cheerio.load(html);
  const name =
    $('meta[property="og:site_name"]').attr('content')?.trim() || $('title').text().trim() || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;
  return { name, description };
}
