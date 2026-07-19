import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { Lead, composeQuery, MapsBlockedError, HubspotNotConfiguredError } from '../services/leads/types.js';
import { pushContacts } from '../services/leads/hubspot.js';
import { scrapeGoogleMaps } from '../services/leads/maps.js';
import { scrapeOverpass, mergeByTitle } from '../services/leads/overpass.js';
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
    details: z.boolean().default(false),
    proxyUrl: z.string().url().optional(),
    proxyBypass: z.string().optional(),
    osmFallback: z.boolean().default(true),
    overpassUrl: z.string().url().optional(),
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
            'Scrape Google Maps for businesses. Provide `query` (raw) or `industry` (+ optional `location`). Set `details: true` to open each result\'s detail panel for website, phone, full address, review count, and category (the list view omits these) — slower, one navigation per result. Optional `proxyUrl` routes this scrape through a per-request proxy (falls back to the global PROXY_URL). When Maps returns fewer than `max` results (or is blocked), the results are topped up from OpenStreetMap — free, no ban risk — provided `industry` and `location` were given (set `osmFallback: false` to disable). Synchronous and long-running; bounded by `max` and LEADS_SCRAPE_TIMEOUT_MS.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2, maxLength: 200 },
              industry: { type: 'string', minLength: 2, maxLength: 120 },
              location: { type: 'string', minLength: 2, maxLength: 120 },
              max: { type: 'integer', minimum: 1, maximum: 500, default: 20, description: 'Number of results to collect. Hard-capped server-side by LEADS_MAX_RESULTS (default 120).' },
              details: { type: 'boolean', default: false, description: 'Open each result\'s detail panel to extract website/phone/full address/review count/category. Slower (one navigation per result); use a smaller `max`.' },
              proxyUrl: { type: 'string', format: 'uri' },
              proxyBypass: { type: 'string' },
              osmFallback: { type: 'boolean', default: true, description: 'Top up from OpenStreetMap when Google Maps returns fewer than `max` results or is blocked. Needs `industry` + `location`.' },
              overpassUrl: { type: 'string', format: 'uri', description: 'Override the Overpass endpoint used for the OSM fallback (default rotates public mirrors).' },
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
        // OSM can only run with a structured industry + location (it needs an
        // area to search); a raw `query` alone can't drive it.
        const canOsm = body.osmFallback && Boolean(body.industry) && Boolean(body.location);

        const warnings: string[] = [];
        let leads: Lead[] = [];

        // 1) Google Maps (primary). A block or failure isn't fatal when OSM can
        // back it up — we fall through to the top-up instead of erroring.
        try {
          const r = await scrapeGoogleMaps({
            browser: deps.browser,
            query,
            max,
            details: body.details,
            proxyUrl: body.proxyUrl,
            proxyBypass: body.proxyBypass,
            timeoutMs: deps.config.leadsScrapeTimeoutMs,
          });
          leads = r.leads;
          warnings.push(...r.warnings);
        } catch (err) {
          const blocked = err instanceof MapsBlockedError;
          if (!canOsm) {
            if (blocked) {
              return reply.code(502).send({ error: 'maps_blocked', message: err.message });
            }
            req.log.warn({ err }, 'leads scrape failed');
            return reply.code(502).send({
              error: 'scrape_failed',
              message: err instanceof Error ? err.message : String(err),
            });
          }
          warnings.push(`google maps ${blocked ? 'blocked' : 'failed'}: ${err instanceof Error ? err.message : String(err)}`);
          req.log.warn({ err }, 'leads maps scrape failed; falling back to OSM');
        }

        // 2) OpenStreetMap top-up when Maps came up short.
        if (canOsm && leads.length < max) {
          try {
            const osm = await scrapeOverpass({
              industry: body.industry as string,
              location: body.location as string,
              max,
              overpassUrl: body.overpassUrl,
              // OSM is fast (geocode + one query); cap it so a full Maps run
              // plus fallback can't blow far past LEADS_SCRAPE_TIMEOUT_MS.
              timeoutMs: Math.min(deps.config.leadsScrapeTimeoutMs, 60_000),
            });
            const before = leads.length;
            leads = mergeByTitle(leads, osm.leads, max);
            warnings.push(...osm.warnings);
            if (leads.length > before) {
              warnings.push(`topped up ${leads.length - before} lead(s) from OpenStreetMap`);
            }
          } catch (err) {
            warnings.push(`osm fallback failed: ${err instanceof Error ? err.message : String(err)}`);
            req.log.warn({ err }, 'leads osm fallback failed');
          }
        }

        return {
          query,
          count: leads.length,
          leads,
          warnings,
          fetchedAt: new Date().toISOString(),
        };
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
