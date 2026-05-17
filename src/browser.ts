import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { PlaywrightProxy } from './proxy.js';

/**
 * Persistent Playwright browser. One Chromium process per server, contexts
 * acquired per request from a simple semaphore-bounded pool.
 *
 * We use contexts (not pages) as the unit of isolation: each request gets a
 * fresh context with its own cookies/storage, then it's closed.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private size: number;
  private proxy?: PlaywrightProxy;
  private inUse = 0;
  private waiters: Array<() => void> = [];

  constructor(size: number, proxy?: PlaywrightProxy) {
    this.size = size;
    this.proxy = proxy;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
      ...(this.proxy ? { proxy: this.proxy } : {}),
    });
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Acquire a fresh context. Caller MUST `await release(context)` in a
   * `finally` block to return the slot to the pool.
   */
  async acquire(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    if (!this.browser) {
      throw new Error('BrowserPool not started');
    }

    while (this.inUse >= this.size) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.inUse += 1;
    try {
      return await this.browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...options,
      });
    } catch (err) {
      this.inUse -= 1;
      this.wakeNext();
      throw err;
    }
  }

  async release(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } finally {
      this.inUse -= 1;
      this.wakeNext();
    }
  }

  private wakeNext(): void {
    const next = this.waiters.shift();
    if (next) next();
  }
}
