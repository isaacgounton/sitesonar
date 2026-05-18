// robots-parser ships an .d.ts with a quirky `declare module` form that breaks
// default-import typing under NodeNext. The runtime export is `module.exports = function`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- d.ts mismatch with CJS default export
import robotsParser from 'robots-parser';

interface RobotsParserResult {
  getCrawlDelay(ua?: string): number | undefined;
}
type RobotsParserFn = (url: string, contents: string) => RobotsParserResult;

export interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface EffectiveRules {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface ParsedRobots {
  rules: RobotsRule[];
  sitemaps: string[];
  effectiveRules?: EffectiveRules;
  raw: string;
}

const MAX_RAW_BYTES = 100 * 1024;

export function parseRobots(
  text: string,
  url: string,
  effectiveUserAgent?: string,
): ParsedRobots {
  const raw = text.length > MAX_RAW_BYTES ? text.slice(0, MAX_RAW_BYTES) : text;

  const lines = text.split(/\r?\n/);
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  let current: RobotsRule | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value && key !== 'user-agent') continue;

    if (key === 'user-agent') {
      if (current) {
        rules.push(current);
      }
      current = { userAgent: value, allow: [], disallow: [], crawlDelay: null };
    } else if (key === 'disallow') {
      if (current) current.disallow.push(value);
    } else if (key === 'allow') {
      if (current) current.allow.push(value);
    } else if (key === 'crawl-delay') {
      const n = parseInt(value, 10);
      if (current && !Number.isNaN(n)) current.crawlDelay = n;
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    }
  }
  if (current) rules.push(current);

  const result: ParsedRobots = { rules, sitemaps, raw };

  if (effectiveUserAgent) {
    const parser = (robotsParser as unknown as RobotsParserFn)(url, text);
    const match = pickMatchingRule(rules, effectiveUserAgent);
    result.effectiveRules = {
      userAgent: effectiveUserAgent,
      allow: match?.allow ?? [],
      disallow: match?.disallow ?? [],
      crawlDelay: parser.getCrawlDelay(effectiveUserAgent) ?? null,
    };
  }

  return result;
}

function pickMatchingRule(rules: RobotsRule[], userAgent: string): RobotsRule | undefined {
  const ua = userAgent.toLowerCase();
  // RFC 9309: longest matching UA prefix wins. Wildcard '*' is the fallback.
  let best: RobotsRule | undefined;
  let bestLen = -1;
  let wildcard: RobotsRule | undefined;
  for (const r of rules) {
    const ruleUa = r.userAgent.toLowerCase();
    if (ruleUa === '*') {
      wildcard = r;
      continue;
    }
    if (ua.includes(ruleUa) && ruleUa.length > bestLen) {
      best = r;
      bestLen = ruleUa.length;
    }
  }
  return best ?? wildcard;
}
