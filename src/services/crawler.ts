import { PlaywrightCrawler, RequestQueue, type PlaywrightCrawlingContext } from 'crawlee';
import {
  emptyResponseHeaders,
  extractMetadata,
  filterResponseHeaders,
  type PageMetadata,
} from './extract.js';
import type { PlaywrightProxy } from '../proxy.js';

export interface CrawlPage {
  url: string;
  status: number | null;
  metadata: PageMetadata;
  outboundLinks: string[];
  depth: number;
  crawledAt: string;
}

export interface CrawlOptions {
  startUrl: string;
  maxRequests: number;
  concurrency: number;
  sameOriginOnly: boolean;
  proxy?: PlaywrightProxy;
  onPage?: (page: CrawlPage) => void;
}

export interface CrawlResult {
  startUrl: string;
  origin: string;
  pages: CrawlPage[];
  graph: Record<string, string[]>;
}

function emptyMetadata(): PageMetadata {
  return {
    title: null,
    description: null,
    canonical: null,
    language: null,
    robots: null,
    viewport: null,
    openGraph: {},
    twitterCard: {},
    headings: { h1: [], h2: [], h3: [] },
    links: { internal: 0, external: 0, nofollow: 0 },
    images: { total: 0, missingAlt: 0 },
    imageList: [],
    linkList: [],
    responseHeaders: emptyResponseHeaders(),
    listsTruncated: { images: false, links: false },
    wordCount: 0,
  };
}

/**
 * Run a bounded Playwright crawl rooted at startUrl. Uses an ephemeral
 * RequestQueue per invocation so concurrent /crawl jobs don't collide.
 */
export async function runCrawl(opts: CrawlOptions): Promise<CrawlResult> {
  const start = new URL(opts.startUrl);
  const origin = start.origin;
  const pages: CrawlPage[] = [];
  const graph: Record<string, string[]> = {};

  const queueName = `crawl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const queue = await RequestQueue.open(queueName);

  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    maxRequestsPerCrawl: opts.maxRequests,
    maxConcurrency: opts.concurrency,
    headless: true,
    launchContext: {
      launchOptions: {
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...(opts.proxy ? { proxy: opts.proxy } : {}),
      },
    },
    async requestHandler(ctx: PlaywrightCrawlingContext) {
      const { request, page, response, enqueueLinks, log } = ctx;
      log.debug(`Visiting ${request.url}`);

      const status = response ? response.status() : null;
      const html = await page.content();
      const metadata = extractMetadata(html, request.url);
      metadata.responseHeaders = filterResponseHeaders(response?.headers());

      const anchors = await page.locator('a[href]').all();
      const outbound: string[] = [];
      for (const anchor of anchors) {
        const href = await anchor.getAttribute('href');
        if (!href) continue;
        try {
          const absolute = new URL(href, request.url).toString();
          const u = new URL(absolute);
          if (!opts.sameOriginOnly || u.origin === origin) {
            outbound.push(absolute);
          }
        } catch {
          // skip mailto:, tel:, javascript:, etc.
        }
      }

      const record: CrawlPage = {
        url: request.url,
        status,
        metadata,
        outboundLinks: Array.from(new Set(outbound)).slice(0, 100),
        depth: (request.userData['depth'] as number | undefined) ?? 0,
        crawledAt: new Date().toISOString(),
      };
      pages.push(record);
      graph[request.url] = record.outboundLinks;

      if (opts.onPage) opts.onPage(record);

      await enqueueLinks({
        strategy: opts.sameOriginOnly ? 'same-origin' : 'all',
        transformRequestFunction(req) {
          req.userData = { ...req.userData, depth: record.depth + 1 };
          return req;
        },
      });
    },
    async failedRequestHandler(ctx, error) {
      const { request, log } = ctx;
      log.warning(`Failed ${request.url}: ${error.message}`);
      pages.push({
        url: request.url,
        status: null,
        metadata: emptyMetadata(),
        outboundLinks: [],
        depth: (request.userData['depth'] as number | undefined) ?? 0,
        crawledAt: new Date().toISOString(),
      });
    },
  });

  try {
    await crawler.run([opts.startUrl]);
  } finally {
    await queue.drop();
  }

  return { startUrl: opts.startUrl, origin, pages, graph };
}
