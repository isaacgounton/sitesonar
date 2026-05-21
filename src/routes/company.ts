import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import {
  lookupCompany,
  ProviderNotConfiguredError,
  ProviderRequestError,
  ProviderQuotaError,
  CompanyNotFoundError,
  NoFirmographicsProvidersError,
  AllProvidersFailedError,
} from '../services/company/index.js';

const Seniority = z.enum([
  'c_suite',
  'vp',
  'director',
  'manager',
  'senior',
  'individual_contributor',
]);

const CompanyBody = z
  .object({
    domain: z.string().min(3).max(253).optional(),
    query: z.string().min(2).max(200).optional(),
    location: z.string().min(2).max(120).optional(),
    firmographicsProvider: z.enum(['hunter', 'google_places', 'schema_org', 'wikidata', 'rdap']).optional(),
    contactsProvider: z.enum(['hunter', 'apollo']).optional(),
    include: z
      .object({
        firmographics: z.boolean().default(true),
        contacts: z.boolean().default(false),
      })
      .default({ firmographics: true, contacts: false }),
    contactsLimit: z.number().int().min(1).max(25).default(5),
    contactFilters: z
      .object({
        titles: z.array(z.string().min(1)).max(20).optional(),
        departments: z.array(z.string().min(1)).max(10).optional(),
        seniority: z.array(Seniority).max(6).optional(),
      })
      .optional(),
  })
  .refine((b) => Boolean(b.domain) !== Boolean(b.query), {
    message: 'Provide exactly one of `domain` or `query`.',
  });

interface CompanyDeps {
  config: Config;
}

export const companyRoutes =
  (deps: CompanyDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/company',
      {
        schema: {
          description:
            'Look up a company by `domain` (enrichment) or `query` (search). Returns firmographic data from Google Places. Optionally returns professional `contacts[]` from Apollo when `include.contacts=true` and APOLLO_API_KEY is configured. Use `location` to disambiguate multi-office brands (e.g. domain=stripe.com, location="San Francisco" → SF HQ rather than Toronto office).',
          tags: ['company'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                minLength: 3,
                maxLength: 253,
                description: 'Apex domain to enrich (e.g. "stripe.com").',
              },
              query: {
                type: 'string',
                minLength: 2,
                maxLength: 200,
                description: 'Search query (e.g. "Stripe headquarters").',
              },
              location: {
                type: 'string',
                minLength: 2,
                maxLength: 120,
                description:
                  'Location bias for both modes. Appended to the search text (e.g. "San Francisco, CA"). Picks the office matching this city.',
              },
              firmographicsProvider: {
                type: 'string',
                enum: ['hunter', 'google_places', 'schema_org', 'wikidata', 'rdap'],
                description:
                  'Pin a single firmographics provider (skips the fallback chain). Default chain (COMPANY_PROVIDERS): hunter → google_places → schema_org → wikidata → rdap. The last three need no API key.',
              },
              contactsProvider: {
                type: 'string',
                enum: ['hunter', 'apollo'],
                description:
                  'Pin a single contacts provider. Default chain (CONTACTS_PROVIDERS): hunter → apollo. Hunter uses /domain-search (free 25/mo, returns names + emails). Apollo requires a paid plan.',
              },
              include: {
                type: 'object',
                properties: {
                  firmographics: { type: 'boolean', default: true },
                  contacts: { type: 'boolean', default: false },
                },
              },
              contactsLimit: {
                type: 'integer',
                minimum: 1,
                maximum: 25,
                default: 5,
              },
              contactFilters: {
                type: 'object',
                properties: {
                  titles: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    maxItems: 20,
                    description: 'Job titles to match (e.g. ["CEO", "VP Marketing"]).',
                  },
                  departments: {
                    type: 'array',
                    items: { type: 'string', minLength: 1 },
                    maxItems: 10,
                    description:
                      'Departments to filter by (e.g. ["engineering", "sales"]).',
                  },
                  seniority: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'c_suite',
                        'vp',
                        'director',
                        'manager',
                        'senior',
                        'individual_contributor',
                      ],
                    },
                    maxItems: 6,
                  },
                },
              },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = CompanyBody.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;

        try {
          const result = await lookupCompany(
            {
              domain: body.domain,
              query: body.query,
              location: body.location,
              firmographicsProvider: body.firmographicsProvider,
              contactsProvider: body.contactsProvider,
              includeFirmographics: body.include.firmographics,
              includeContacts: body.include.contacts,
              contactsLimit: body.contactsLimit,
              contactFilters: body.contactFilters,
            },
            deps.config,
          );
          return {
            query: { domain: body.domain, query: body.query },
            company: result.company,
            contacts: result.contacts,
            providersUsed: result.providersUsed,
            warnings: result.warnings,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          if (err instanceof NoFirmographicsProvidersError) {
            return reply.code(503).send({
              error: 'no_providers_configured',
              message: err.message,
            });
          }
          if (err instanceof AllProvidersFailedError) {
            return reply.code(502).send({
              error: 'all_providers_failed',
              attempts: err.attempts,
            });
          }
          if (err instanceof ProviderNotConfiguredError) {
            return reply.code(400).send({
              error: 'provider_not_configured',
              provider: err.provider,
              message:
                'Forced provider has no API key configured (see .env.example: HUNTER_API_KEY, GOOGLE_PLACES_API_KEY, APOLLO_API_KEY).',
            });
          }
          if (err instanceof CompanyNotFoundError) {
            return reply
              .code(404)
              .send({ error: 'company_not_found', message: err.message });
          }
          if (err instanceof ProviderQuotaError) {
            return reply.code(402).send({
              error: 'provider_quota_exceeded',
              provider: err.provider,
              message: err.message,
            });
          }
          if (err instanceof ProviderRequestError) {
            return reply.code(502).send({
              error: 'provider_failed',
              provider: err.provider,
              status: err.status,
              message: err.message,
            });
          }
          req.log.warn({ err }, 'company unexpected error');
          return reply.code(500).send({
            error: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
