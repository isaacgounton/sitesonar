import { describe, it, expect } from 'vitest';
import { extractMetadata } from './extract.js';

describe('extractMetadata wordCount', () => {
  it('counts visible body words, ignoring script/style/noscript', () => {
    const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
      <body>
        <h1>Hello world</h1>
        <p>one two three</p>
        <script>var ignored = "lots of script words here";</script>
        <noscript>ignored too</noscript>
      </body></html>`;
    const m = extractMetadata(html, 'https://example.com/');
    expect(m.wordCount).toBe(5);
  });

  it('returns 0 for an empty body', () => {
    const m = extractMetadata('<html><body></body></html>', 'https://example.com/');
    expect(m.wordCount).toBe(0);
  });

  it('counts inline SVG as visual content separate from <img>', () => {
    const html = `<html><body>
      <img src="/a.png" alt="a">
      <svg viewBox="0 0 1 1"><path/></svg>
      <svg viewBox="0 0 1 1"><circle/></svg>
    </body></html>`;
    const m = extractMetadata(html, 'https://example.com/');
    expect(m.images.total).toBe(1);
    expect(m.images.svg).toBe(2);
  });

  it('does not break heading/link extraction (word count runs last)', () => {
    const html = `<html><body>
      <h1>Head</h1>
      <a href="/x">link text</a>
    </body></html>`;
    const m = extractMetadata(html, 'https://example.com/');
    expect(m.headings.h1).toEqual(['Head']);
    expect(m.links.internal).toBe(1);
    expect(m.wordCount).toBe(3);
  });
});
