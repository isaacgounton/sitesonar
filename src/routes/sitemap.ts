import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { resolveSitemap, type SitemapFetcher } from '../services/sitemap.js';
import { parseRobots } from '../services/robots.js';

const SitemapBody = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(50_000).optional(),
  followIndex: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface SitemapDeps {
  config: Config;
}

const DISCOVERY_PATHS = ['/sitemap.xml', '/sitemap_index.xml'] as const;

function buildFetcher(timeout: number): SitemapFetcher {
  return async (url) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  };
}

async function discoverSitemapUrl(
  rootInput: string,
  fetcher: SitemapFetcher,
): Promise<string | null> {
  const root = new URL(rootInput);
  for (const path of DISCOVERY_PATHS) {
    const candidate = new URL(path, root).toString();
    try {
      await fetcher(candidate);
      return candidate;
    } catch {
      // try the next discovery path
    }
  }
  try {
    const robotsUrl = new URL('/robots.txt', root).toString();
    const robotsText = await fetcher(robotsUrl);
    const parsed = parseRobots(robotsText, robotsUrl);
    if (parsed.sitemaps.length > 0) return parsed.sitemaps[0]!;
  } catch {
    // no robots.txt or no sitemap line
  }
  return null;
}

function looksLikeSitemapUrl(u: string): boolean {
  const path = new URL(u).pathname;
  return /sitemap.*\.xml(\.gz)?$/i.test(path) || /\.xml(\.gz)?$/i.test(path);
}

export const sitemapRoutes =
  (deps: SitemapDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/sitemap',
      {
        schema: {
          description:
            'Fetch and parse an XML sitemap. Follows sitemap-index one level. Auto-discovers /sitemap.xml when given a site root.',
          tags: ['discovery'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              limit: { type: 'integer', minimum: 1, maximum: 50_000 },
              followIndex: { type: 'boolean' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = SitemapBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const limit = body.limit ?? 50_000;
        const followIndex = body.followIndex ?? true;
        const timeout = body.timeoutMs ?? deps.config.sitemapTimeoutMs;
        const fetcher = buildFetcher(timeout);

        let sitemapUrl = body.url;
        if (!looksLikeSitemapUrl(body.url)) {
          const discovered = await discoverSitemapUrl(body.url, fetcher);
          if (!discovered) {
            return reply.code(404).send({
              error: 'no_sitemap_found',
              message: 'No sitemap at common paths or in robots.txt',
            });
          }
          sitemapUrl = discovered;
        }

        try {
          const result = await resolveSitemap(sitemapUrl, fetcher, { limit, followIndex });
          return {
            url: body.url,
            finalUrl: sitemapUrl,
            ...result,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'sitemap fetch failed');
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.code(504).send({ error: 'timeout', message: `Exceeded ${timeout}ms` });
          }
          return reply.code(502).send({
            error: 'fetch_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
