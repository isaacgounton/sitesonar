import type { Config } from '../config.js';

export type ProviderName = 'searxng' | 'brave' | 'google' | 'serpapi' | 'serper' | 'tavily';

export interface SearchQuery {
  query: string;
  num: number;
  country?: string;
  lang?: string;
}

export interface OrganicResult {
  position: number;
  title: string;
  link: string;
  snippet: string;
  displayLink: string | null;
}

export interface SearchFeatures {
  featuredSnippet: {
    title: string | null;
    link: string | null;
    snippet: string | null;
  } | null;
  knowledgePanel: {
    title: string | null;
    type: string | null;
    description: string | null;
  } | null;
}

export interface SearchData {
  organic: OrganicResult[];
  paa: string[];
  related: string[];
  features: SearchFeatures;
  totalResults: number | null;
}

export interface SearchResult extends SearchData {
  query: string;
  providerUsed: ProviderName;
  searchedAt: string;
  providerFallbacks: Array<{ provider: ProviderName; error: string }>;
}

interface SearchProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  search(query: SearchQuery, signal: AbortSignal): Promise<SearchData>;
}

function emptyFeatures(): SearchFeatures {
  return { featuredSnippet: null, knowledgePanel: null };
}

function safeDisplayLink(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    // Drain body for a useful error tail but cap the size.
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ─── SearXNG ───────────────────────────────────────────────────────────────
// Self-hosted meta-search. JSON endpoint must be enabled on the instance
// (settings.yml: search.formats includes 'json'). Free, no key.

class SearxngProvider implements SearchProvider {
  readonly name = 'searxng' as const;
  constructor(private url?: string) {}
  isConfigured(): boolean {
    return !!this.url;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const params = new URLSearchParams({ q: q.query, format: 'json' });
    if (q.lang) params.set('language', q.lang);
    const base = this.url!.replace(/\/$/, '');
    const data = (await fetchJson(`${base}/search?${params}`, { method: 'GET' }, signal)) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
      suggestions?: string[];
      answers?: string[];
    };
    const organic: OrganicResult[] = (data.results ?? [])
      .slice(0, q.num)
      .map((r, i) => ({
        position: i + 1,
        title: r.title ?? '',
        link: r.url ?? '',
        snippet: r.content ?? '',
        displayLink: safeDisplayLink(r.url ?? ''),
      }));
    return {
      organic,
      paa: [],
      related: data.suggestions ?? [],
      features: emptyFeatures(),
      totalResults: null,
    };
  }
}

// ─── Brave Search API ──────────────────────────────────────────────────────
// 2,000 queries/mo free. Independent index, real SERP-quality results.
// https://api.search.brave.com/app/documentation

class BraveProvider implements SearchProvider {
  readonly name = 'brave' as const;
  constructor(private apiKey?: string) {}
  isConfigured(): boolean {
    return !!this.apiKey;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const params = new URLSearchParams({ q: q.query, count: String(Math.min(q.num, 20)) });
    if (q.country) params.set('country', q.country.toLowerCase());
    if (q.lang) params.set('search_lang', q.lang);
    const data = (await fetchJson(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      { headers: { 'X-Subscription-Token': this.apiKey!, Accept: 'application/json' } },
      signal,
    )) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          netloc?: string;
        }>;
      };
      infobox?: { title?: string; type?: string; description?: string };
      faq?: { results?: Array<{ question?: string }> };
    };
    const organic: OrganicResult[] = (data.web?.results ?? []).map((r, i) => ({
      position: i + 1,
      title: r.title ?? '',
      link: r.url ?? '',
      snippet: r.description ?? '',
      displayLink: r.netloc ?? safeDisplayLink(r.url ?? ''),
    }));
    const features = emptyFeatures();
    if (data.infobox) {
      features.knowledgePanel = {
        title: data.infobox.title ?? null,
        type: data.infobox.type ?? null,
        description: data.infobox.description ?? null,
      };
    }
    return {
      organic,
      paa: (data.faq?.results ?? []).map((f) => f.question ?? '').filter(Boolean),
      related: [],
      features,
      totalResults: null,
    };
  }
}

// ─── Google Custom Search ──────────────────────────────────────────────────
// 100 queries/day free. Real Google results. Requires a CSE configured at
// programmablesearchengine.google.com. Limit 10 results per request.

class GoogleCseProvider implements SearchProvider {
  readonly name = 'google' as const;
  constructor(
    private apiKey?: string,
    private cx?: string,
  ) {}
  isConfigured(): boolean {
    return !!this.apiKey && !!this.cx;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const params = new URLSearchParams({
      key: this.apiKey!,
      cx: this.cx!,
      q: q.query,
      num: String(Math.min(q.num, 10)),
    });
    if (q.country) params.set('gl', q.country);
    if (q.lang) params.set('lr', `lang_${q.lang}`);
    const data = (await fetchJson(
      `https://www.googleapis.com/customsearch/v1?${params}`,
      { method: 'GET' },
      signal,
    )) as {
      items?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        displayLink?: string;
      }>;
      searchInformation?: { totalResults?: string };
    };
    const organic: OrganicResult[] = (data.items ?? []).map((r, i) => ({
      position: i + 1,
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
      displayLink: r.displayLink ?? safeDisplayLink(r.link ?? ''),
    }));
    return {
      organic,
      paa: [],
      related: [],
      features: emptyFeatures(),
      totalResults: data.searchInformation?.totalResults
        ? Number(data.searchInformation.totalResults)
        : null,
    };
  }
}

// ─── SerpAPI ───────────────────────────────────────────────────────────────
// 100 queries/mo free. Real Google SERPs with the richest feature coverage:
// answer box, knowledge graph, related questions, related searches.
// Different service from Serper.dev (similar name, totally different auth and
// response shape). https://serpapi.com

class SerpapiProvider implements SearchProvider {
  readonly name = 'serpapi' as const;
  constructor(private apiKey?: string) {}
  isConfigured(): boolean {
    return !!this.apiKey;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const params = new URLSearchParams({
      engine: 'google',
      q: q.query,
      num: String(q.num),
      api_key: this.apiKey!,
    });
    if (q.country) params.set('gl', q.country);
    if (q.lang) params.set('hl', q.lang);
    const data = (await fetchJson(
      `https://serpapi.com/search?${params}`,
      { method: 'GET' },
      signal,
    )) as {
      organic_results?: Array<{
        position?: number;
        title?: string;
        link?: string;
        snippet?: string;
        displayed_link?: string;
      }>;
      related_questions?: Array<{ question?: string }>;
      related_searches?: Array<{ query?: string }>;
      answer_box?: { title?: string; link?: string; snippet?: string; answer?: string };
      knowledge_graph?: { title?: string; type?: string; description?: string };
      search_information?: { total_results?: number };
      error?: string;
    };
    if (data.error) throw new Error(`SerpAPI: ${data.error}`);
    const organic: OrganicResult[] = (data.organic_results ?? []).map((r, i) => ({
      position: r.position ?? i + 1,
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
      displayLink: r.displayed_link ?? safeDisplayLink(r.link ?? ''),
    }));
    const features = emptyFeatures();
    if (data.answer_box) {
      features.featuredSnippet = {
        title: data.answer_box.title ?? null,
        link: data.answer_box.link ?? null,
        snippet: data.answer_box.snippet ?? data.answer_box.answer ?? null,
      };
    }
    if (data.knowledge_graph) {
      features.knowledgePanel = {
        title: data.knowledge_graph.title ?? null,
        type: data.knowledge_graph.type ?? null,
        description: data.knowledge_graph.description ?? null,
      };
    }
    return {
      organic,
      paa: (data.related_questions ?? []).map((p) => p.question ?? '').filter(Boolean),
      related: (data.related_searches ?? []).map((r) => r.query ?? '').filter(Boolean),
      features,
      totalResults: data.search_information?.total_results ?? null,
    };
  }
}

// ─── Serper.dev ────────────────────────────────────────────────────────────
// ~2,500 free credits on sign-up. Real Google SERPs with rich features:
// PAA, related searches, answer box, knowledge graph. Different service
// from SerpAPI (similar name, totally different auth and response shape).
// https://serper.dev

class SerperProvider implements SearchProvider {
  readonly name = 'serper' as const;
  constructor(private apiKey?: string) {}
  isConfigured(): boolean {
    return !!this.apiKey;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const body: Record<string, unknown> = { q: q.query, num: q.num };
    if (q.country) body.gl = q.country;
    if (q.lang) body.hl = q.lang;
    const data = (await fetchJson(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      signal,
    )) as {
      organic?: Array<{
        position?: number;
        title?: string;
        link?: string;
        snippet?: string;
      }>;
      peopleAlsoAsk?: Array<{ question?: string }>;
      relatedSearches?: Array<{ query?: string }>;
      answerBox?: { title?: string; link?: string; snippet?: string; answer?: string };
      knowledgeGraph?: { title?: string; type?: string; description?: string };
      searchParameters?: { num?: number };
    };
    const organic: OrganicResult[] = (data.organic ?? []).map((r, i) => ({
      position: r.position ?? i + 1,
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
      displayLink: safeDisplayLink(r.link ?? ''),
    }));
    const features = emptyFeatures();
    if (data.answerBox) {
      features.featuredSnippet = {
        title: data.answerBox.title ?? null,
        link: data.answerBox.link ?? null,
        snippet: data.answerBox.snippet ?? data.answerBox.answer ?? null,
      };
    }
    if (data.knowledgeGraph) {
      features.knowledgePanel = {
        title: data.knowledgeGraph.title ?? null,
        type: data.knowledgeGraph.type ?? null,
        description: data.knowledgeGraph.description ?? null,
      };
    }
    return {
      organic,
      paa: (data.peopleAlsoAsk ?? []).map((p) => p.question ?? '').filter(Boolean),
      related: (data.relatedSearches ?? []).map((r) => r.query ?? '').filter(Boolean),
      features,
      totalResults: null,
    };
  }
}

// ─── Tavily ────────────────────────────────────────────────────────────────
// 1,000 queries/mo free. LLM-optimized — cleaned results, optional summary
// answer. Does not surface SERP features (no PAA / knowledge panel).

class TavilyProvider implements SearchProvider {
  readonly name = 'tavily' as const;
  constructor(private apiKey?: string) {}
  isConfigured(): boolean {
    return !!this.apiKey;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const data = (await fetchJson(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: q.query,
          max_results: q.num,
          search_depth: 'basic',
        }),
      },
      signal,
    )) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
      answer?: string;
    };
    const organic: OrganicResult[] = (data.results ?? []).map((r, i) => ({
      position: i + 1,
      title: r.title ?? '',
      link: r.url ?? '',
      snippet: r.content ?? '',
      displayLink: safeDisplayLink(r.url ?? ''),
    }));
    const features = emptyFeatures();
    if (data.answer) {
      features.featuredSnippet = {
        title: null,
        link: null,
        snippet: data.answer,
      };
    }
    return {
      organic,
      paa: [],
      related: [],
      features,
      totalResults: null,
    };
  }
}

/**
 * Build the ordered provider chain from config. Filters out providers that
 * lack credentials so the chain only contains usable entries. The order is
 * exactly `config.searchProviders` — first match wins, fallbacks follow.
 */
export function buildProviders(config: Config): SearchProvider[] {
  const all: Record<ProviderName, SearchProvider> = {
    searxng: new SearxngProvider(config.searxngUrl),
    brave: new BraveProvider(config.braveSearchApiKey),
    google: new GoogleCseProvider(config.googleSearchApiKey, config.googleSearchCx),
    serpapi: new SerpapiProvider(config.serpapiApiKey),
    serper: new SerperProvider(config.serperApiKey),
    tavily: new TavilyProvider(config.tavilyApiKey),
  };
  return config.searchProviders.map((n) => all[n]).filter((p) => p.isConfigured());
}

export interface RunSearchOptions {
  providers: SearchProvider[];
  timeoutMs: number;
  /** Force a specific provider, bypassing the fallback chain. */
  forceEngine?: ProviderName;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export class NoSearchProvidersError extends Error {
  constructor() {
    super('No search providers are configured');
    this.name = 'NoSearchProvidersError';
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(name: ProviderName) {
    super(`Requested provider "${name}" is not configured`);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: Array<{ provider: ProviderName; error: string }>) {
    super(`All search providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')}`);
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Run a search against the provider chain. Each provider gets `timeoutMs` to
 * respond. On error or timeout, the next provider in the chain is tried.
 * `forceEngine` short-circuits the chain and uses a single named provider.
 */
export async function runSearch(
  q: SearchQuery,
  opts: RunSearchOptions,
): Promise<SearchResult> {
  if (opts.providers.length === 0) throw new NoSearchProvidersError();

  let chain: SearchProvider[];
  if (opts.forceEngine) {
    const forced = opts.providers.find((p) => p.name === opts.forceEngine);
    if (!forced) throw new ProviderNotConfiguredError(opts.forceEngine);
    chain = [forced];
  } else {
    chain = opts.providers;
  }

  const attempts: Array<{ provider: ProviderName; error: string }> = [];
  for (const provider of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const data = await provider.search(q, controller.signal);
      return {
        query: q.query,
        providerUsed: provider.name,
        searchedAt: new Date().toISOString(),
        providerFallbacks: attempts,
        ...data,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: provider.name, error: msg });
      opts.logger?.warn(
        { provider: provider.name, err },
        `search provider ${provider.name} failed; falling through`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AllProvidersFailedError(attempts);
}
