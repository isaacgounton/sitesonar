import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { JobStore } from '../jobs.js';
import { deriveProxy } from '../proxy.js';
import { runCrawl, type CrawlResult } from '../services/crawler.js';

const CrawlBody = z.object({
  startUrl: z.string().url(),
  maxRequests: z.number().int().positive().max(500).optional(),
  concurrency: z.number().int().positive().max(20).optional(),
  sameOriginOnly: z.boolean().default(true),
});

interface CrawlDeps {
  jobs: JobStore;
  config: Config;
}

export const crawlRoutes =
  (deps: CrawlDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Start an async crawl. Returns a job id immediately.
     */
    app.post(
      '/v1/crawl',
      {
        schema: {
          description:
            'Start a multi-page crawl. Returns a job id; poll /v1/jobs/{id} for status and result.',
          tags: ['crawl'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['startUrl'],
            properties: {
              startUrl: { type: 'string', format: 'uri' },
              maxRequests: { type: 'integer', minimum: 1, maximum: 500 },
              concurrency: { type: 'integer', minimum: 1, maximum: 20 },
              sameOriginOnly: { type: 'boolean', default: true },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = CrawlBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const job = await deps.jobs.create<CrawlResult>();

        // Fire and forget. Errors land on the job record.
        void (async () => {
          await deps.jobs.markRunning(job.id);
          let processed = 0;
          try {
            const result = await runCrawl({
              startUrl: body.startUrl,
              maxRequests: body.maxRequests ?? deps.config.crawlMaxRequests,
              concurrency: body.concurrency ?? deps.config.crawlDefaultConcurrency,
              sameOriginOnly: body.sameOriginOnly,
              proxy: deriveProxy(deps.config),
              onPage(page) {
                processed += 1;
                void deps.jobs.updateProgress(job.id, processed);
                req.log.debug(`Crawled ${page.url}`);
              },
            });
            await deps.jobs.markSucceeded(job.id, result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            req.log.warn({ err }, `crawl ${job.id} failed`);
            await deps.jobs.markFailed(job.id, msg);
          }
        })();

        return reply.code(202).send({
          jobId: job.id,
          status: job.status,
          pollUrl: `/v1/jobs/${job.id}`,
          createdAt: job.createdAt,
        });
      },
    );

    /**
     * Poll a job by id. Returns full result once status is `succeeded`.
     */
    app.get<{ Params: { id: string } }>(
      '/v1/jobs/:id',
      {
        schema: {
          description: 'Fetch the status (and result, if complete) of a crawl job.',
          tags: ['crawl'],
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
      async (req, reply) => {
        const job = await deps.jobs.get(req.params.id);
        if (!job) return reply.code(404).send({ error: 'job_not_found' });
        return job;
      },
    );
  };
