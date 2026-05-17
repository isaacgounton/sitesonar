export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

/**
 * Derive a Playwright proxy config from env-style options. Accepts a single
 * `proxyUrl` of the form `http(s)://[user:pass@]host:port` (or socks5). Auth
 * is extracted from the URL — Playwright and Crawlee both want it split out
 * rather than embedded in the server string.
 *
 * Returns undefined if no proxyUrl is set or it doesn't parse. Callers should
 * spread the result conditionally so it's a no-op when proxying is disabled.
 */
export function deriveProxy(opts: {
  proxyUrl?: string;
  proxyBypass?: string;
}): PlaywrightProxy | undefined {
  if (!opts.proxyUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(opts.proxyUrl);
  } catch {
    return undefined;
  }
  const proxy: PlaywrightProxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  if (opts.proxyBypass) proxy.bypass = opts.proxyBypass;
  return proxy;
}
