import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BrowserContext } from 'playwright';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { htmlToMarkdown } from '../services/extract.js';
import { extractArticle } from '../services/readability.js';

interface ExportDeps {
  browser: BrowserPool;
  config: Config;
}

// Shared body fields for both /pdf and /md. PDF-specific options live on the
// PdfBody refinement; /md adds a `mode` flag.
const CommonBody = z.object({
  url: z.string().url().optional(),
  html: z.string().optional(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  waitForSelector: z.string().optional(),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(180_000).optional(),
});

const requireUrlOrHtml = (d: { url?: string; html?: string }): boolean =>
  !!d.url !== !!d.html;

const MarginSchema = z.object({
  top: z.string().optional(),
  right: z.string().optional(),
  bottom: z.string().optional(),
  left: z.string().optional(),
});

const PdfBody = CommonBody.extend({
  format: z
    .enum(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid', 'Ledger'])
    .optional(),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  scale: z.number().min(0.1).max(2).default(1),
  margin: MarginSchema.optional(),
  width: z.string().optional(),
  height: z.string().optional(),
  displayHeaderFooter: z.boolean().default(false),
  headerTemplate: z.string().optional(),
  footerTemplate: z.string().optional(),
  pageRanges: z.string().optional(),
  preferCSSPageSize: z.boolean().default(false),
  emulatePrintMedia: z.boolean().default(true),
}).refine(requireUrlOrHtml, {
  message: 'Provide exactly one of `url` or `html`',
  path: ['url'],
});

const MdBody = CommonBody.extend({
  /**
   * full: turndown of the whole rendered page (matches /v1/scrape markdown).
   * article: Readability extracts the article body first (matches /v1/extract).
   */
  mode: z.enum(['full', 'article']).default('article'),
}).refine(requireUrlOrHtml, {
  message: 'Provide exactly one of `url` or `html`',
  path: ['url'],
});

const Query = z.object({
  base64: z.enum(['true', 'false']).optional(),
  json: z.enum(['true', 'false']).optional(),
});

/**
 * Open a page from either a URL navigation or raw HTML. Caller owns the
 * context lifecycle (acquire/release).
 */
async function preparePage(
  context: BrowserContext,
  body: { url?: string; html?: string; waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; waitForSelector?: string },
  timeout: number,
): Promise<{ page: Awaited<ReturnType<BrowserContext['newPage']>>; finalUrl: string; status: number | null }> {
  const page = await context.newPage();
  let status: number | null = null;
  if (body.url) {
    const response = await page.goto(body.url, { waitUntil: body.waitUntil, timeout });
    status = response ? response.status() : null;
  } else {
    await page.setContent(body.html!, { waitUntil: body.waitUntil, timeout });
  }
  if (body.waitForSelector) {
    await page.waitForSelector(body.waitForSelector, { timeout });
  }
  return { page, finalUrl: page.url(), status };
}

export const exportRoutes =
  (deps: ExportDeps): FastifyPluginAsync =>
  async (app) => {
    // ---------------------------------------------------------------------
    // POST /v1/export/pdf — binary PDF (or base64-wrapped JSON via ?base64=true)
    // ---------------------------------------------------------------------
    app.post(
      '/v1/export/pdf',
      {
        schema: {
          description:
            'Render a URL (or raw HTML) and return a PDF. Binary `application/pdf` by default; pass ?base64=true to wrap the bytes in a JSON envelope.',
          tags: ['export'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              html: { type: 'string' },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                default: 'networkidle',
              },
              waitForSelector: { type: 'string' },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 180_000 },
              format: {
                type: 'string',
                enum: ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid', 'Ledger'],
              },
              landscape: { type: 'boolean', default: false },
              printBackground: { type: 'boolean', default: true },
              scale: { type: 'number', minimum: 0.1, maximum: 2, default: 1 },
              margin: {
                type: 'object',
                properties: {
                  top: { type: 'string' },
                  right: { type: 'string' },
                  bottom: { type: 'string' },
                  left: { type: 'string' },
                },
              },
              width: { type: 'string' },
              height: { type: 'string' },
              displayHeaderFooter: { type: 'boolean', default: false },
              headerTemplate: { type: 'string' },
              footerTemplate: { type: 'string' },
              pageRanges: { type: 'string' },
              preferCSSPageSize: { type: 'boolean', default: false },
              emulatePrintMedia: { type: 'boolean', default: true },
            },
          },
        },
      },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = PdfBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const q = Query.safeParse(req.query);
        const wantBase64 = q.success && q.data.base64 === 'true';

        const timeout = body.timeoutMs ?? deps.config.pdfTimeoutMs;
        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const { page } = await preparePage(context, body, timeout);

          if (body.emulatePrintMedia) {
            await page.emulateMedia({ media: 'print' });
          }

          const pdfBuffer = await page.pdf({
            ...(body.format ? { format: body.format } : {}),
            landscape: body.landscape,
            printBackground: body.printBackground,
            scale: body.scale,
            ...(body.margin ? { margin: body.margin } : {}),
            ...(body.width ? { width: body.width } : {}),
            ...(body.height ? { height: body.height } : {}),
            displayHeaderFooter: body.displayHeaderFooter,
            ...(body.headerTemplate ? { headerTemplate: body.headerTemplate } : {}),
            ...(body.footerTemplate ? { footerTemplate: body.footerTemplate } : {}),
            ...(body.pageRanges ? { pageRanges: body.pageRanges } : {}),
            preferCSSPageSize: body.preferCSSPageSize,
          });

          if (wantBase64) {
            return {
              contentType: 'application/pdf',
              size: pdfBuffer.length,
              data: pdfBuffer.toString('base64'),
            };
          }

          reply.type('application/pdf');
          reply.header('Content-Disposition', 'inline; filename="page.pdf"');
          reply.header('Content-Length', String(pdfBuffer.length));
          return reply.send(pdfBuffer);
        } catch (err) {
          req.log.warn({ err }, 'pdf export failed');
          return reply.code(502).send({
            error: 'pdf_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );

    // ---------------------------------------------------------------------
    // POST /v1/export/md — markdown body (or JSON envelope via ?json=true)
    // ---------------------------------------------------------------------
    app.post(
      '/v1/export/md',
      {
        schema: {
          description:
            'Render a URL (or raw HTML) and return Markdown. `mode=article` (default) uses Readability to strip nav/footer. `mode=full` converts the entire rendered page. `text/markdown` by default; pass ?json=true for a JSON envelope.',
          tags: ['export'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              html: { type: 'string' },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                default: 'networkidle',
              },
              waitForSelector: { type: 'string' },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 180_000 },
              mode: { type: 'string', enum: ['full', 'article'], default: 'article' },
            },
          },
        },
      },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = MdBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const q = Query.safeParse(req.query);
        const wantJson = q.success && q.data.json === 'true';

        const timeout = body.timeoutMs ?? deps.config.scrapeTimeoutMs;
        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const { page, finalUrl, status } = await preparePage(context, body, timeout);

          let markdown: string;
          let articleTitle: string | null = null;
          let extractionFailed = false;
          if (body.mode === 'article') {
            const result = await extractArticle(page);
            if (result.article) {
              markdown = result.article.contentMarkdown;
              articleTitle = result.article.title;
            } else {
              extractionFailed = true;
              // Fall back to the full-page conversion so callers get *something*.
              const html = await page.content();
              markdown = htmlToMarkdown(html);
            }
          } else {
            const html = await page.content();
            markdown = htmlToMarkdown(html);
          }

          if (wantJson) {
            return {
              url: body.url ?? null,
              finalUrl,
              status,
              mode: body.mode,
              title: articleTitle,
              extractionFailed,
              wordCount: markdown.trim().split(/\s+/).filter(Boolean).length,
              markdown,
              fetchedAt: new Date().toISOString(),
            };
          }

          reply.type('text/markdown; charset=utf-8');
          reply.header('Content-Disposition', 'inline; filename="page.md"');
          return reply.send(markdown);
        } catch (err) {
          req.log.warn({ err }, 'md export failed');
          return reply.code(502).send({
            error: 'md_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
