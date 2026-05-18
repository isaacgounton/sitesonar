import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { parseRobots } from '../services/robots.js';

const RobotsBody = z.object({
  url: z.string().url(),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface RobotsDeps {
  config: Config;
}

function normalizeUrl(input: string): string {
  if (input.endsWith('/robots.txt')) return input;
  const u = new URL(input);
  u.pathname = '/robots.txt';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export const robotsRoutes =
  (deps: RobotsDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/robots',
      {
        schema: {
          description:
            "Fetch and parse a site's robots.txt. Returns structured rules, sitemap URLs, and optionally user-agent-resolved rules.",
          tags: ['discovery'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = RobotsBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const robotsUrl = normalizeUrl(body.url);
        const timeout = body.timeoutMs ?? deps.config.robotsTimeoutMs;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(robotsUrl, { redirect: 'follow', signal: controller.signal });
          if (response.status === 404) {
            return {
              url: robotsUrl,
              finalUrl: response.url,
              status: 404,
              rules: [],
              sitemaps: [],
              raw: '',
              fetchedAt: new Date().toISOString(),
            };
          }
          const text = await response.text();
          const result = parseRobots(text, response.url, body.userAgent);
          return {
            url: robotsUrl,
            finalUrl: response.url,
            status: response.status,
            ...result,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'robots fetch failed');
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.code(504).send({ error: 'timeout', message: `Exceeded ${timeout}ms` });
          }
          return reply.code(502).send({
            error: 'fetch_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
