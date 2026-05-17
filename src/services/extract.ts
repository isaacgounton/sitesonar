import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonical: string | null;
  language: string | null;
  robots: string | null;
  viewport: string | null;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  headings: {
    h1: string[];
    h2: string[];
    h3: string[];
  };
  links: {
    internal: number;
    external: number;
    nofollow: number;
  };
  images: {
    total: number;
    missingAlt: number;
  };
}

export function extractMetadata(html: string, pageUrl: string): PageMetadata {
  const $ = cheerio.load(html);
  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return '';
    }
  })();

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr('property');
    const content = $(el).attr('content');
    if (prop && content) og[prop.slice(3)] = content;
  });

  const tw: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr('name');
    const content = $(el).attr('content');
    if (name && content) tw[name.slice(8)] = content;
  });

  const collectHeadings = (selector: string): string[] =>
    $(selector)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

  let internal = 0;
  let external = 0;
  let nofollow = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (($(el).attr('rel') ?? '').includes('nofollow')) nofollow += 1;
    try {
      const abs = new URL(href, pageUrl);
      if (origin && abs.origin === origin) internal += 1;
      else external += 1;
    } catch {
      // ignore invalid hrefs (mailto:, tel:, anchors)
    }
  });

  const imgs = $('img');
  const missingAlt = imgs.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;

  return {
    title: $('title').first().text().trim() || null,
    description: $('meta[name="description"]').attr('content')?.trim() ?? null,
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    language: $('html').attr('lang') ?? null,
    robots: $('meta[name="robots"]').attr('content') ?? null,
    viewport: $('meta[name="viewport"]').attr('content') ?? null,
    openGraph: og,
    twitterCard: tw,
    headings: {
      h1: collectHeadings('h1'),
      h2: collectHeadings('h2'),
      h3: collectHeadings('h3'),
    },
    links: { internal, external, nofollow },
    images: { total: imgs.length, missingAlt },
  };
}

// Single Turndown instance — configuration is stateless across calls.
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

/**
 * Convert HTML to markdown using turndown. Strips scripts/styles/iframes/svg
 * up-front via cheerio and preserves headings, links, lists, code blocks,
 * blockquotes, and inline emphasis. Replaces the previous hand-rolled walker.
 */
export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, svg').remove();
  const body = $('body').html() ?? $.html();
  return turndown
    .turndown(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
