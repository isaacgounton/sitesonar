import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Job<T = unknown> {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: T;
  error?: string;
  progress?: { processed: number; total?: number };
}

export interface JobStore {
  create<T>(): Promise<Job<T>>;
  get<T>(id: string): Promise<Job<T> | undefined>;
  markRunning(id: string): Promise<void>;
  markSucceeded<T>(id: string, result: T): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  updateProgress(id: string, processed: number, total?: number): Promise<void>;
  close?(): Promise<void>;
}

interface LoggerLike {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface JobStoreFactoryOptions {
  redisUrl?: string;
  jobTtlSeconds: number;
  logger: LoggerLike;
}

/**
 * Pick a JobStore implementation based on whether REDIS_URL is configured.
 * In-memory store is the default — fine for single-instance, low-volume use.
 * Redis-backed store survives restarts and supports multi-replica deploys.
 */
export async function createJobStore(opts: JobStoreFactoryOptions): Promise<JobStore> {
  if (opts.redisUrl) {
    const store = await RedisJobStore.connect(opts.redisUrl, opts.jobTtlSeconds, opts.logger);
    opts.logger.info(`Job store: Redis (${opts.redisUrl.replace(/:[^:@]*@/, ':***@')})`);
    return store;
  }
  opts.logger.info('Job store: in-memory (ephemeral; set REDIS_URL for persistence)');
  return new InMemoryJobStore();
}

/**
 * Bounded in-memory job store. Wiped on restart. Evicts oldest jobs once
 * `maxJobs` is reached.
 */
export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private maxJobs: number;

  constructor(maxJobs = 500) {
    this.maxJobs = maxJobs;
  }

  async create<T>(): Promise<Job<T>> {
    this.evictOldestIfFull();
    const job: Job<T> = {
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job as Job);
    return job;
  }

  async get<T>(id: string): Promise<Job<T> | undefined> {
    return this.jobs.get(id) as Job<T> | undefined;
  }

  async markRunning(id: string): Promise<void> {
    this.patch(id, { status: 'running', startedAt: new Date().toISOString() });
  }

  async markSucceeded<T>(id: string, result: T): Promise<void> {
    this.patch(id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      result,
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.patch(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error,
    });
  }

  async updateProgress(id: string, processed: number, total?: number): Promise<void> {
    this.patch(id, { progress: { processed, total } });
  }

  private patch<T>(id: string, patch: Partial<Job<T>>): void {
    const existing = this.jobs.get(id);
    if (!existing) return;
    this.jobs.set(id, { ...existing, ...patch });
  }

  private evictOldestIfFull(): void {
    if (this.jobs.size < this.maxJobs) return;
    const oldest = this.jobs.keys().next().value;
    if (oldest) this.jobs.delete(oldest);
  }
}

/**
 * Redis-backed job store. Each job is serialized as a single JSON string at
 * key `sitesonar:job:<id>` with a TTL (default 24h). Survives restarts and
 * works across multiple replicas — but does not retry orphaned jobs (a
 * replica that dies mid-crawl leaves the job stuck in `running`; treat that
 * as the cost of keeping this layer queue-free).
 */
export class RedisJobStore implements JobStore {
  private redis: Redis;
  private ttlSeconds: number;
  private logger: LoggerLike;
  private static prefix = 'sitesonar:job:';

  private constructor(redis: Redis, ttlSeconds: number, logger: LoggerLike) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.logger = logger;
  }

  static async connect(
    url: string,
    ttlSeconds: number,
    logger: LoggerLike,
  ): Promise<RedisJobStore> {
    const redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    redis.on('error', (err) => logger.warn({ err }, 'redis error'));
    await redis.connect();
    return new RedisJobStore(redis, ttlSeconds, logger);
  }

  async create<T>(): Promise<Job<T>> {
    const job: Job<T> = {
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.redis.set(this.key(job.id), JSON.stringify(job), 'EX', this.ttlSeconds);
    return job;
  }

  async get<T>(id: string): Promise<Job<T> | undefined> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Job<T>;
    } catch (err) {
      this.logger.warn({ err, id }, 'corrupt job record');
      return undefined;
    }
  }

  async markRunning(id: string): Promise<void> {
    await this.patch(id, { status: 'running', startedAt: new Date().toISOString() });
  }

  async markSucceeded<T>(id: string, result: T): Promise<void> {
    await this.patch(id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      result,
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.patch(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error,
    });
  }

  async updateProgress(id: string, processed: number, total?: number): Promise<void> {
    await this.patch(id, { progress: { processed, total } });
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private key(id: string): string {
    return RedisJobStore.prefix + id;
  }

  private async patch<T>(id: string, patch: Partial<Job<T>>): Promise<void> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return;
    let job: Job<T>;
    try {
      job = JSON.parse(raw) as Job<T>;
    } catch {
      return;
    }
    const next = { ...job, ...patch };
    // KEEPTTL preserves expiry so reads still drop after the original window.
    await this.redis.set(this.key(id), JSON.stringify(next), 'KEEPTTL');
  }
}
