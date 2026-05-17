import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { extractMetadata } from '../services/extract.js';
import { analyzeStructuredData } from '../services/schema.js';
import { runLighthouse, type LighthousePreset } from '../services/lighthouse.js';

const AuditBody = z.object({
  url: z.string().url(),
  preset: z.enum(['mobile', 'desktop']).default('mobile'),
  skipLighthouse: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(180_000).optional(),
});

interface AuditDeps {
  browser: BrowserPool;
  config: Config;
}

export const auditPageRoutes =
  (deps: AuditDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/audit-page',
      {
        schema: {
          description:
            'Full single-page SEO audit: metadata, structured data, and Lighthouse (perf / a11y / SEO / best practices). Slow (10-30s typical, longer for heavy pages).',
          tags: ['audit'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              preset: { type: 'string', enum: ['mobile', 'desktop'], default: 'mobile' },
              skipLighthouse: { type: 'boolean', default: false },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 180_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = AuditBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.auditTimeoutMs;

        // 1. Render the page with our pool for metadata + schema analysis.
        const context = await deps.browser.acquire();
        let html: string;
        let finalUrl: string;
        let status: number | null;
        try {
          const page = await context.newPage();
          const response = await page.goto(body.url, {
            waitUntil: 'networkidle',
            timeout: Math.min(timeout, deps.config.scrapeTimeoutMs),
          });
          html = await page.content();
          finalUrl = page.url();
          status = response ? response.status() : null;
        } catch (err) {
          req.log.warn({ err }, 'audit render failed');
          return reply.code(502).send({
            error: 'render_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }

        const metadata = extractMetadata(html, finalUrl);
        const structuredData = await analyzeStructuredData(html);

        // 2. Lighthouse (separate Chrome instance to avoid stomping on our pool).
        let lighthouse: Awaited<ReturnType<typeof runLighthouse>> | null = null;
        let lighthouseError: string | null = null;
        if (!body.skipLighthouse) {
          try {
            lighthouse = await runLighthouse(
              body.url,
              body.preset as LighthousePreset,
              timeout,
            );
          } catch (err) {
            lighthouseError = err instanceof Error ? err.message : String(err);
            req.log.warn({ err }, 'lighthouse failed');
          }
        }

        return {
          url: body.url,
          finalUrl,
          status,
          preset: body.preset,
          metadata,
          structuredData,
          lighthouse,
          lighthouseError,
          auditedAt: new Date().toISOString(),
        };
      },
    );
  };
