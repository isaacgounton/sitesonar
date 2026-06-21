import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { composeQuery, MapsBlockedError, HubspotNotConfiguredError } from '../services/leads/types.js';
import { pushContacts } from '../services/leads/hubspot.js';
import { scrapeGoogleMaps } from '../services/leads/maps.js';
import { enrichLeads } from '../services/leads/enrich.js';

interface LeadsDeps {
  browser: BrowserPool;
  config: Config;
}

const ScrapeBody = z
  .object({
    query: z.string().min(2).max(200).optional(),
    industry: z.string().min(2).max(120).optional(),
    location: z.string().min(2).max(120).optional(),
    max: z.number().int().min(1).max(500).default(20),
    proxyUrl: z.string().url().optional(),
    proxyBypass: z.string().optional(),
  })
  .refine((b) => Boolean(b.query) || Boolean(b.industry), {
    message: 'Provide `query` or `industry` (with optional `location`).',
  });

const LeadSchema = z
  .object({
    title: z.string(),
    rating: z.number().optional(),
    reviewCount: z.number().optional(),
    phone: z.string().optional(),
    category: z.string().optional(),
    address: z.string().optional(),
    website: z.string().optional(),
    googleMapsLink: z.string().optional(),
    email: z.string().optional(),
    emailConfidence: z.enum(['scraped', 'guessed']).optional(),
    description: z.string().optional(),
    linkedin: z.string().optional(),
    facebook: z.string().optional(),
    instagram: z.string().optional(),
    hubspotId: z.string().optional(),
  })
  .passthrough();

const EnrichBody = z.object({
  leads: z.array(LeadSchema).min(1).max(500),
  guessEmails: z.boolean().default(true),
  verifyMx: z.boolean().default(true),
  headlessFallback: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(10).default(3),
});

const HubspotBody = z.object({
  leads: z.array(LeadSchema).min(1).max(500),
  token: z.string().min(10).optional(),
  industry: z.string().min(2).max(120).optional(),
  dryRun: z.boolean().default(false),
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
              max: { type: 'integer', minimum: 1, maximum: 500, default: 20, description: 'Number of results to collect. Hard-capped server-side by LEADS_MAX_RESULTS (default 120).' },
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

    app.post(
      '/v1/leads/enrich',
      {
        schema: {
          description:
            'Enrich leads by crawling each business website for emails, phone, social profiles, and description. Accepts the `leads[]` array returned by /v1/leads/scrape. Falls back to a role-based email guess (MX-verified) when no email is scraped.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['leads'],
            properties: {
              leads: { type: 'array', items: { type: 'object' } },
              guessEmails: { type: 'boolean', default: true },
              verifyMx: { type: 'boolean', default: true },
              headlessFallback: { type: 'boolean', default: true },
              concurrency: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = EnrichBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const { leads, warnings } = await enrichLeads({
          browser: deps.browser,
          leads: body.leads,
          guessEmails: body.guessEmails,
          verifyMx: body.verifyMx,
          headlessFallback: body.headlessFallback,
          concurrency: body.concurrency,
          timeoutMs: deps.config.leadsEnrichTimeoutMs,
        });
        return {
          count: leads.length,
          leads,
          warnings,
          enrichedAt: new Date().toISOString(),
        };
      },
    );

    app.post(
      '/v1/leads/hubspot',
      {
        schema: {
          description:
            'Push enriched leads into HubSpot as contacts. Dedupes by email then phone, creates only custom properties that exist in the account, and auto-creates the type_contact enum option from `industry`. Uses the request `token` or the HUBSPOT_TOKEN env. Set `dryRun=true` to preview without writing.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['leads'],
            properties: {
              leads: { type: 'array', items: { type: 'object' } },
              token: { type: 'string', minLength: 10 },
              industry: { type: 'string', minLength: 2, maxLength: 120 },
              dryRun: { type: 'boolean', default: false },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = HubspotBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const token = body.token ?? deps.config.hubspotToken;
        try {
          if (!token) throw new HubspotNotConfiguredError();
          const result = await pushContacts({
            token,
            leads: body.leads,
            industry: body.industry,
            dryRun: body.dryRun,
          });
          return { ...result, pushedAt: new Date().toISOString() };
        } catch (err) {
          if (err instanceof HubspotNotConfiguredError) {
            return reply.code(503).send({ error: 'hubspot_not_configured', message: err.message });
          }
          req.log.warn({ err }, 'leads hubspot push failed');
          return reply.code(502).send({
            error: 'hubspot_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
