import { describe, it, expect } from 'vitest';
import { gradeHeaders } from './security-headers.js';

describe('gradeHeaders', () => {
  it('returns grade A for a fully-configured set of headers', () => {
    const result = gradeHeaders({
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'self'; script-src 'self'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=()',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(result.grade).toBe('A');
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it('returns grade F for empty headers', () => {
    const result = gradeHeaders({});
    expect(result.grade).toBe('F');
    expect(result.score).toBeLessThan(40);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0]).toContain('Content-Security-Policy');
  });

  it('credits X-Frame-Options when CSP frame-ancestors is present', () => {
    const result = gradeHeaders({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    expect(result.headers['x-frame-options']!.status).toBe('pass');
    expect(result.headers['x-frame-options']!.note).toContain('frame-ancestors');
  });

  it('warns when CSP script-src contains unsafe-inline', () => {
    const result = gradeHeaders({
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
    });
    expect(result.headers['content-security-policy']!.status).toBe('warn');
    expect(result.headers['content-security-policy']!.note).toContain('unsafe-inline');
  });

  it('penalizes Server and X-Powered-By info leak', () => {
    const result = gradeHeaders({
      server: 'nginx/1.18.0',
      'x-powered-by': 'Express',
    });
    expect(result.headers['server-info-leak']!.status).toBe('fail');
    expect(result.recommendations.some((r) => r.includes('Server'))).toBe(true);
  });
});
