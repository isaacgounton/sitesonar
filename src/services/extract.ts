import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export interface ImageDetail {
  src: string;
  alt: string;
  width: string | null;
  height: string | null;
  loading: string | null;
  fetchpriority: string | null;
}

export interface LinkDetail {
  href: string;
  text: string;
  rel: string;
  type: 'internal' | 'external';
  nofollow: boolean;
  target: string | null;
}

/**
 * Whitelisted response headers surfaced on PageMetadata. Headers checked-and-
 * missing are returned as null so consumers can distinguish "absent" from
 * "we didn't look." Keep this list focused on SEO and security signals —
 * dumping every header would blow up the payload and leak ops info.
 */
export const HEADER_WHITELIST = [
  'content-type',
  'cache-control',
  'expires',
  'etag',
  'last-modified',
  'vary',
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'server',
  'x-powered-by',
  'link',
] as const;

export type ResponseHeaders = Record<(typeof HEADER_WHITELIST)[number], string | null>;

export const IMAGE_LIST_CAP = 500;
export const LINK_LIST_CAP = 1000;

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
    /** Inline <svg> elements — real visual content that <img> counting misses. */
    svg: number;
  };
  /** First IMAGE_LIST_CAP <img> elements with src resolved against finalUrl. */
  imageList: ImageDetail[];
  /** First LINK_LIST_CAP <a href> elements with href resolved + internal/external classified. */
  linkList: LinkDetail[];
  /** Whitelisted response headers from the HTTP fetch; null = checked & absent. */
  responseHeaders: ResponseHeaders;
  /** True when imageList or linkList was truncated by the per-page cap. */
  listsTruncated: { images: boolean; links: boolean };
  /** Visible body text word count (script/style/noscript stripped). */
  wordCount: number;
}

/**
 * Build an empty ResponseHeaders record with every whitelisted key set to null.
 * Used for the no-response case (e.g. crawler failedRequestHandler) and as the
 * starting point for filterResponseHeaders.
 */
export function emptyResponseHeaders(): ResponseHeaders {
  const out = {} as ResponseHeaders;
  for (const h of HEADER_WHITELIST) out[h] = null;
  return out;
}

/**
 * Filter a raw response header map down to the whitelist. Header names are
 * compared case-insensitively (Playwright already lowercases, but be defensive).
 */
export function filterResponseHeaders(
  raw: Record<string, string> | null | undefined,
): ResponseHeaders {
  const out = emptyResponseHeaders();
  if (!raw) return out;
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) lc[k.toLowerCase()] = v;
  for (const h of HEADER_WHITELIST) {
    if (lc[h] !== undefined) out[h] = lc[h];
  }
  return out;
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
  const linkList: LinkDetail[] = [];
  let linksTruncated = false;
  $('a[href]').each((_, el) => {
    const rawHref = $(el).attr('href');
    if (!rawHref) return;
    const rel = ($(el).attr('rel') ?? '').trim();
    const isNofollow = rel.includes('nofollow');
    if (isNofollow) nofollow += 1;
    let absolute: string;
    let type: 'internal' | 'external';
    try {
      const abs = new URL(rawHref, pageUrl);
      absolute = abs.toString();
      type = origin && abs.origin === origin ? 'internal' : 'external';
      if (type === 'internal') internal += 1;
      else external += 1;
    } catch {
      // skip mailto:, tel:, javascript:, anchor-only, etc.
      return;
    }
    if (linkList.length < LINK_LIST_CAP) {
      linkList.push({
        href: absolute,
        text: $(el).text().trim(),
        rel,
        type,
        nofollow: isNofollow,
        target: $(el).attr('target') ?? null,
      });
    } else {
      linksTruncated = true;
    }
  });

  const imgs = $('img');
  // Inline SVG icons/illustrations are visual content the <img> list can't see —
  // count them so consumers don't mistake an SVG-built page for having no visuals.
  const svgCount = $('svg').length;
  let missingAlt = 0;
  const imageList: ImageDetail[] = [];
  let imagesTruncated = false;
  imgs.each((_, el) => {
    const alt = ($(el).attr('alt') ?? '').trim();
    if (!alt) missingAlt += 1;
    if (imageList.length >= IMAGE_LIST_CAP) {
      imagesTruncated = true;
      return;
    }
    // Prefer src; fall back to common lazy-load attrs so the list isn't empty
    // on pages that defer image loading via data-src.
    const rawSrc =
      $(el).attr('src') ??
      $(el).attr('data-src') ??
      $(el).attr('data-lazy-src') ??
      null;
    if (!rawSrc) return;
    let absoluteSrc: string;
    try {
      absoluteSrc = new URL(rawSrc, pageUrl).toString();
    } catch {
      return;
    }
    imageList.push({
      src: absoluteSrc,
      alt,
      width: $(el).attr('width') ?? null,
      height: $(el).attr('height') ?? null,
      loading: $(el).attr('loading') ?? null,
      fetchpriority: $(el).attr('fetchpriority') ?? null,
    });
  });

  // Word count last — removing script/style mutates the tree the extractors above read.
  $('script, style, noscript').remove();
  const bodyText = ($('body').text() || $.root().text()).replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

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
    images: { total: imgs.length, missingAlt, svg: svgCount },
    imageList,
    linkList,
    responseHeaders: emptyResponseHeaders(),
    listsTruncated: { images: imagesTruncated, links: linksTruncated },
    wordCount,
  };
}

// Single Turndown instance — configuration is stateless across calls.
export const turndown = new TurndownService({
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
