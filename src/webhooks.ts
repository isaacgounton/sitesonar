import { createHmac } from 'node:crypto';

interface WebhookLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface DispatchOptions {
  url: string;
  payload: unknown;
  /** When set, the body is HMAC-SHA256-signed and sent in X-Sitesonar-Signature. */
  secret: string | undefined;
  logger: WebhookLogger;
  retries?: number;
  timeoutMs?: number;
}

const DEFAULT_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Best-effort webhook delivery. POSTs JSON to `url`, signs with HMAC-SHA256
 * when `secret` is supplied. Retries once on 5xx or network error after a
 * 5-second pause. 4xx responses are NOT retried — the receiver has rejected
 * the call deliberately.
 *
 * Never throws — failures are logged and swallowed so the calling job lifecycle
 * is unaffected. Webhooks are not the source of truth; /v1/jobs/{id} is.
 */
export async function dispatchWebhook(opts: DispatchOptions): Promise<void> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'sitesonar-webhook/1',
    'X-Sitesonar-Signature': opts.secret ? sign(body, opts.secret) : 'unsigned',
  };

  const maxRetries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        opts.logger.info(
          { url: opts.url, status: res.status, attempt },
          'webhook delivered',
        );
        return;
      }
      if (res.status >= 500 && attempt < maxRetries) {
        opts.logger.warn(
          { url: opts.url, status: res.status, attempt },
          'webhook returned 5xx; retrying',
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      opts.logger.warn(
        { url: opts.url, status: res.status, attempt },
        'webhook delivery failed (non-retryable)',
      );
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        opts.logger.warn({ err, url: opts.url, attempt }, 'webhook error; retrying');
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      opts.logger.warn({ err, url: opts.url, attempt }, 'webhook error; giving up');
      return;
    } finally {
      clearTimeout(timer);
    }
  }
}
