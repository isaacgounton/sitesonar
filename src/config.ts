import { z } from 'zod';

const csv = (raw: string | undefined): string[] =>
  raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  apiKeys: z.array(z.string().min(8)).min(1, 'At least one API key required'),
  corsOrigins: z.array(z.string()).default(['*']),
  crawlMaxRequests: z.coerce.number().int().positive().default(50),
  crawlDefaultConcurrency: z.coerce.number().int().positive().default(5),
  scrapeTimeoutMs: z.coerce.number().int().positive().default(30_000),
  auditTimeoutMs: z.coerce.number().int().positive().default(90_000),
  screenshotTimeoutMs: z.coerce.number().int().positive().default(20_000),
  browserPoolSize: z.coerce.number().int().positive().default(3),
  crawleeStorageDir: z.string().default('/tmp/crawlee'),
  proxyUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  proxyBypass: z.string().optional(),
  redisUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  jobTtlSeconds: z.coerce.number().int().positive().default(86_400),
  // Search providers — comma-separated list defines the fallback order.
  // Each provider is only used if its credentials are configured below.
  searchProviders: z
    .array(z.enum(['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily']))
    .default(['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily']),
  searxngUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  braveSearchApiKey: z.string().optional(),
  googleSearchApiKey: z.string().optional(),
  googleSearchCx: z.string().optional(),
  serpapiApiKey: z.string().optional(),
  serperApiKey: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  searchTimeoutMs: z.coerce.number().int().positive().default(8_000),
  securityTimeoutMs: z.coerce.number().int().positive().default(10_000),
  robotsTimeoutMs: z.coerce.number().int().positive().default(10_000),
  sitemapTimeoutMs: z.coerce.number().int().positive().default(15_000),
  extractTimeoutMs: z.coerce.number().int().positive().default(30_000),
  techTimeoutMs: z.coerce.number().int().positive().default(30_000),
  rateLimitPerMin: z.coerce.number().int().positive().default(60),
  webhookSecret: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    port: process.env.PORT,
    host: process.env.HOST,
    logLevel: process.env.LOG_LEVEL,
    apiKeys: csv(process.env.API_KEYS),
    corsOrigins: csv(process.env.CORS_ORIGINS),
    crawlMaxRequests: process.env.CRAWL_MAX_REQUESTS,
    crawlDefaultConcurrency: process.env.CRAWL_DEFAULT_CONCURRENCY,
    scrapeTimeoutMs: process.env.SCRAPE_TIMEOUT_MS,
    auditTimeoutMs: process.env.AUDIT_TIMEOUT_MS,
    screenshotTimeoutMs: process.env.SCREENSHOT_TIMEOUT_MS,
    browserPoolSize: process.env.BROWSER_POOL_SIZE,
    crawleeStorageDir: process.env.CRAWLEE_STORAGE_DIR,
    proxyUrl: process.env.PROXY_URL,
    proxyBypass: process.env.PROXY_BYPASS,
    redisUrl: process.env.REDIS_URL,
    jobTtlSeconds: process.env.JOB_TTL_SECONDS,
    searchProviders: process.env.SEARCH_PROVIDERS
      ? csv(process.env.SEARCH_PROVIDERS)
      : undefined,
    searxngUrl: process.env.SEARXNG_URL ?? process.env.SEARCHXNG_URL,
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
    googleSearchApiKey: process.env.GOOGLE_SEARCH_API_KEY,
    googleSearchCx: process.env.GOOGLE_SEARCH_CX,
    serpapiApiKey: process.env.SERPAPI_KEY,
    serperApiKey: process.env.SERPER_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    searchTimeoutMs: process.env.SEARCH_TIMEOUT_MS,
    securityTimeoutMs: process.env.SECURITY_TIMEOUT_MS,
    robotsTimeoutMs: process.env.ROBOTS_TIMEOUT_MS,
    sitemapTimeoutMs: process.env.SITEMAP_TIMEOUT_MS,
    extractTimeoutMs: process.env.EXTRACT_TIMEOUT_MS,
    techTimeoutMs: process.env.TECH_TIMEOUT_MS,
    rateLimitPerMin: process.env.RATE_LIMIT_PER_MIN,
    webhookSecret: process.env.WEBHOOK_SECRET,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  process.env.CRAWLEE_STORAGE_DIR = parsed.data.crawleeStorageDir;
  return parsed.data;
}
