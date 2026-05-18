import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import {
  AllProvidersFailedError,
  NoSearchProvidersError,
  ProviderNotConfiguredError,
  buildProviders,
  runSearch,
} from '../services/search.js';

const SearchBody = z.object({
  query: z.string().min(1).max(500),
  num: z.number().int().min(1).max(50).default(10),
  country: z.string().min(2).max(2).optional(),
  lang: z.string().min(2).max(5).optional(),
  engine: z.enum(['searxng', 'brave', 'google', 'serper', 'tavily']).optional(),
});

interface SearchDeps {
  config: Config;
}

export const searchRoutes =
  (deps: SearchDeps): FastifyPluginAsync =>
  async (app) => {
    const providers = buildProviders(deps.config);
    app.log.info(
      `Search providers configured: ${providers.length === 0 ? '(none)' : providers.map((p) => p.name).join(' → ')}`,
    );

    app.post(
      '/v1/search',
      {
        schema: {
          description:
            'Search the web through a free-first provider chain (SearXNG → Brave → Google CSE → Serper → Tavily by default). Falls through to the next provider on 4xx/5xx/timeout. Use `engine` to pin a specific provider and skip the chain.',
          tags: ['search'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 500 },
              num: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
              country: {
                type: 'string',
                minLength: 2,
                maxLength: 2,
                description: 'ISO 3166-1 alpha-2 country code (e.g. "us")',
              },
              lang: {
                type: 'string',
                minLength: 2,
                maxLength: 5,
                description: 'ISO 639-1 language code (e.g. "en")',
              },
              engine: {
                type: 'string',
                enum: ['searxng', 'brave', 'google', 'serper', 'tavily'],
                description: 'Force a specific provider; otherwise the fallback chain runs.',
              },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = SearchBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;

        try {
          const result = await runSearch(
            {
              query: body.query,
              num: body.num,
              country: body.country,
              lang: body.lang,
            },
            {
              providers,
              timeoutMs: deps.config.searchTimeoutMs,
              forceEngine: body.engine,
              logger: req.log,
            },
          );
          return result;
        } catch (err) {
          if (err instanceof NoSearchProvidersError) {
            return reply.code(503).send({
              error: 'no_providers_configured',
              message:
                'No search providers are available. Configure at least one of SEARXNG_URL, BRAVE_SEARCH_API_KEY, GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX, SERPER_API_KEY, or TAVILY_API_KEY.',
            });
          }
          if (err instanceof ProviderNotConfiguredError) {
            return reply.code(400).send({
              error: 'engine_not_configured',
              message: err.message,
            });
          }
          if (err instanceof AllProvidersFailedError) {
            return reply.code(502).send({
              error: 'all_providers_failed',
              attempts: err.attempts,
            });
          }
          req.log.warn({ err }, 'search unexpected error');
          return reply.code(500).send({
            error: 'internal_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
