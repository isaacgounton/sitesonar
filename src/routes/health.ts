import type { FastifyPluginAsync } from 'fastify';
import type { JobStore } from '../jobs.js';
import type { Config } from '../config.js';

interface HealthDeps {
  jobs: JobStore;
  startedAt: Date;
  config: Config;
}

export const healthRoutes = (deps: HealthDeps): FastifyPluginAsync => async (app) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Liveness probe + capacity snapshot. Public (no auth).',
        tags: ['system'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              uptimeSeconds: { type: 'number' },
              version: { type: 'string' },
              browserPoolSize: { type: 'integer' },
              rateLimitPerMin: { type: 'integer' },
            },
          },
        },
      },
    },
    async () => {
      const uptimeSeconds = Math.floor((Date.now() - deps.startedAt.getTime()) / 1000);
      return {
        status: 'ok',
        uptimeSeconds,
        version: process.env.npm_package_version ?? '0.1.0',
        browserPoolSize: deps.config.browserPoolSize,
        rateLimitPerMin: deps.config.rateLimitPerMin,
      };
    },
  );

  // alias
  app.get('/healthz', async () => ({ status: 'ok' }));
};
