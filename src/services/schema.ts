import * as cheerio from 'cheerio';
// structured-data-testing-tool is CJS without published TS types.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- no @types available
import { structuredDataTestHtml } from 'structured-data-testing-tool';

export interface SchemaItem {
  type: string;
  raw: unknown;
  errors: string[];
}

export interface SchemaValidationIssue {
  test: string;
  type: string | null;
  schema: string | null;
  message: string;
}

export interface SchemaValidationSummary {
  passed: number;
  failed: number;
  warnings: number;
  failures: SchemaValidationIssue[];
  warningIssues: SchemaValidationIssue[];
}

export interface SchemaReport {
  jsonLdCount: number;
  microdataCount: number;
  rdfaCount: number;
  items: SchemaItem[];
  warnings: string[];
  /**
   * Deep schema.org validation via structured-data-testing-tool. Auto-detects
   * schemas in the page and runs the test suite. Absent (undefined) only if
   * the deep run threw an unrecoverable error — counts above are still valid.
   */
  validation?: SchemaValidationSummary;
}

interface SttTest {
  test?: string;
  type?: string;
  schema?: string;
  description?: string;
  error?: { message?: string } | string;
  message?: string;
}

interface SttResult {
  passed?: SttTest[];
  failed?: SttTest[];
  warnings?: SttTest[];
}

function asIssue(t: SttTest): SchemaValidationIssue {
  const errMsg =
    typeof t.error === 'string'
      ? t.error
      : (t.error?.message ?? t.message ?? t.description ?? 'failed');
  return {
    test: t.test ?? 'unknown',
    type: t.type ?? null,
    schema: t.schema ?? null,
    message: errMsg,
  };
}

function summarize(res: SttResult): SchemaValidationSummary {
  const failures = (res.failed ?? []).map(asIssue);
  const warningIssues = (res.warnings ?? []).map(asIssue);
  return {
    passed: (res.passed ?? []).length,
    failed: failures.length,
    warnings: warningIssues.length,
    failures,
    warningIssues,
  };
}

async function runDeepValidation(html: string): Promise<SchemaValidationSummary | undefined> {
  try {
    const res = (await structuredDataTestHtml(html, { auto: true })) as SttResult;
    return summarize(res);
  } catch (err) {
    // STT rejects when any test fails; the full result hangs off the error.
    const maybeRes = (err as { res?: SttResult }).res;
    if (maybeRes) return summarize(maybeRes);
    return undefined;
  }
}

/**
 * Extracts and validates structured data from rendered HTML. Two layers:
 *   1. Counts JSON-LD blocks, microdata, and RDFa (cheap, always runs).
 *   2. Runs structured-data-testing-tool's schema.org test suite over the
 *      page (slower; absent only if the deep run errored unrecoverably).
 */
export async function analyzeStructuredData(html: string): Promise<SchemaReport> {
  const $ = cheerio.load(html);
  const items: SchemaItem[] = [];
  const warnings: string[] = [];

  const jsonLdBlocks = $('script[type="application/ld+json"]');
  jsonLdBlocks.each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          const type = obj['@type'];
          items.push({
            type:
              typeof type === 'string'
                ? type
                : Array.isArray(type)
                  ? type.join(',')
                  : 'Unknown',
            raw: obj,
            errors: [],
          });
        }
      };
      collect(parsed);
    } catch (err) {
      warnings.push(
        `Invalid JSON-LD block: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const microdataCount = $('[itemscope]').length;
  const rdfaCount = $('[typeof], [property]').length;

  const validation = await runDeepValidation(html);

  return {
    jsonLdCount: jsonLdBlocks.length,
    microdataCount,
    rdfaCount,
    items,
    warnings,
    validation,
  };
}
