import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { composeQuery, MapsBlockedError } from '../services/leads/types.js';
import { scrapeGoogleMaps } from '../services/leads/maps.js';

interface LeadsDeps {
  browser: BrowserPool;
  config: Config;
}

const ScrapeBody = z
  .object({
    query: z.string().min(2).max(200).optional(),
    industry: z.string().min(2).max(120).optional(),
    location: z.string().min(2).max(120).optional(),
    max: z.number().int().min(1).default(20),
    proxyUrl: z.string().url().optional(),
    proxyBypass: z.string().optional(),
  })
  .refine((b) => Boolean(b.query) || Boolean(b.industry), {
    message: 'Provide `query` or `industry` (with optional `location`).',
  });

export const leadsRoutes =
  (deps: LeadsDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/leads/scrape',
      {
        schema: {
          description:
            'Scrape Google Maps for businesses. Provide `query` (raw) or `industry` (+ optional `location`). Optional `proxyUrl` routes this scrape through a per-request proxy (falls back to the global PROXY_URL). Synchronous and long-running; bounded by `max` and LEADS_SCRAPE_TIMEOUT_MS.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2, maxLength: 200 },
              industry: { type: 'string', minLength: 2, maxLength: 120 },
              location: { type: 'string', minLength: 2, maxLength: 120 },
              max: { type: 'integer', minimum: 1, default: 20 },
              proxyUrl: { type: 'string', format: 'uri' },
              proxyBypass: { type: 'string' },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = ScrapeBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const query = composeQuery(body);
        const max = Math.min(body.max, deps.config.leadsMaxResults);

        try {
          const { leads, warnings } = await scrapeGoogleMaps({
            browser: deps.browser,
            query,
            max,
            proxyUrl: body.proxyUrl,
            proxyBypass: body.proxyBypass,
            timeoutMs: deps.config.leadsScrapeTimeoutMs,
          });
          return {
            query,
            count: leads.length,
            leads,
            warnings,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          if (err instanceof MapsBlockedError) {
            return reply.code(502).send({ error: 'maps_blocked', message: err.message });
          }
          req.log.warn({ err }, 'leads scrape failed');
          return reply.code(502).send({
            error: 'scrape_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
