import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { loadConfig } from './config.js';
import { authPlugin } from './auth.js';
import { BrowserPool } from './browser.js';
import { deriveProxy } from './proxy.js';
import { createJobStore, type JobStore } from './jobs.js';
import { healthRoutes } from './routes/health.js';
import { scrapeRoutes } from './routes/scrape.js';
import { screenshotRoutes } from './routes/screenshot.js';
import { auditPageRoutes } from './routes/audit-page.js';
import { crawlRoutes } from './routes/crawl.js';
import { searchRoutes } from './routes/search.js';
import { securityRoutes } from './routes/security.js';
import { robotsRoutes } from './routes/robots.js';
import { sitemapRoutes } from './routes/sitemap.js';
import { extractRoutes } from './routes/extract.js';
import { techRoutes } from './routes/tech.js';
import { exportRoutes } from './routes/export.js';
import { createKvStore, type KvStore } from './kvstore.js';
import { rateLimitPlugin } from './ratelimit.js';
import { usageRoutes } from './routes/usage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = new Date();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(process.env.NODE_ENV !== 'production'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    bodyLimit: 5 * 1024 * 1024, // 5MB
    trustProxy: true,
  });

  // OpenAPI + Swagger UI
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Sitesonar',
        description:
          'Self-hosted scraping and SEO audit API. Endpoints under /v1 require Authorization: Bearer <API_KEY>.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'API key from API_KEYS env var.',
          },
        },
      },
      tags: [
        { name: 'system', description: 'Health and metadata' },
        { name: 'scrape', description: 'Single-page scraping and screenshots' },
        { name: 'audit', description: 'Lighthouse + structured data audits' },
        { name: 'crawl', description: 'Multi-page crawls (async jobs)' },
        { name: 'search', description: 'Web search through a provider chain' },
        { name: 'security', description: 'HTTP security headers grading' },
        { name: 'discovery', description: 'Sitemap and robots.txt parsing' },
        { name: 'extract', description: 'Readability article extraction' },
        { name: 'tech', description: 'Technology stack fingerprinting' },
        { name: 'export', description: 'Export pages as PDF or Markdown' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Expose the OpenAPI spec at the conventional /openapi.{json,yaml} paths
  // in addition to the UI's /docs/json default. Hidden from the spec itself.
  app.get(
    '/openapi.json',
    { schema: { hide: true } },
    async () => app.swagger(),
  );
  app.get(
    '/openapi.yaml',
    { schema: { hide: true } },
    async (_req, reply) => {
      reply.type('application/yaml');
      return app.swagger({ yaml: true });
    },
  );

  // CORS — minimal hand-rolled to avoid an extra dep.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = config.corsOrigins;
    if (!origin) return;
    if (allowed.includes('*') || allowed.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      reply.header('Access-Control-Max-Age', '600');
    }
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  // Auth
  await app.register(authPlugin, { apiKeys: config.apiKeys });

  // KV store (rate limit + diff) — falls back to in-memory if Redis missing.
  const kv: KvStore = await createKvStore({
    redisUrl: config.redisUrl,
    logger: app.log,
  });

  // Rate limiting (must register after authPlugin so 401 wins over 429).
  await app.register(rateLimitPlugin, {
    kv,
    limitPerMin: config.rateLimitPerMin,
  });

  // Shared state
  const proxy = deriveProxy(config);
  if (proxy) app.log.info(`Outbound proxy: ${proxy.server}`);
  const browser = new BrowserPool(config.browserPoolSize, proxy);
  await browser.start();
  app.log.info(`Browser pool started (size=${config.browserPoolSize})`);

  const jobs: JobStore = await createJobStore({
    redisUrl: config.redisUrl,
    jobTtlSeconds: config.jobTtlSeconds,
    logger: app.log,
  });

  // Routes
  await app.register(healthRoutes({ jobs, startedAt }));
  await app.register(scrapeRoutes({ browser, config, kv }));
  await app.register(screenshotRoutes({ browser, config }));
  await app.register(auditPageRoutes({ browser, config }));
  await app.register(crawlRoutes({ jobs, config }));
  await app.register(searchRoutes({ config }));
  await app.register(securityRoutes({ config }));
  await app.register(robotsRoutes({ config }));
  await app.register(sitemapRoutes({ config }));
  await app.register(extractRoutes({ browser, config, kv }));
  await app.register(techRoutes({ browser, config }));
  await app.register(exportRoutes({ browser, config }));
  await app.register(usageRoutes({ kv, limitPerMin: config.rateLimitPerMin }));

  // Lifecycle
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      await app.close();
      await browser.stop();
      await jobs.close?.();
      await kv.close?.();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`sitesonar listening on http://${config.host}:${config.port}`);
  app.log.info(`OpenAPI docs at http://${config.host}:${config.port}/docs`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
