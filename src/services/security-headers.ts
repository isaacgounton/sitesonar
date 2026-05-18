export type HeaderStatus = 'pass' | 'warn' | 'fail';

export interface HeaderCheck {
  present: boolean;
  value: string | null;
  status: HeaderStatus;
  note: string | null;
}

export interface SecurityGrade {
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  headers: Record<string, HeaderCheck>;
  recommendations: string[];
}

interface Rule {
  header: string;
  weight: number;
  recommendation: string;
  check: (
    value: string | null,
    allHeaders: Record<string, string>,
  ) => { status: HeaderStatus; note: string | null; awarded: number };
}

const RULES: Rule[] = [
  {
    header: 'strict-transport-security',
    weight: 20,
    recommendation: 'Add Strict-Transport-Security with max-age of at least 6 months',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      const m = value.match(/max-age=(\d+)/i);
      const maxAge = m && m[1] ? parseInt(m[1], 10) : 0;
      const SIX_MONTHS = 60 * 60 * 24 * 180;
      if (maxAge < SIX_MONTHS) {
        return { status: 'warn', note: `max-age is ${maxAge}s, below 6 months`, awarded: 10 };
      }
      return { status: 'pass', note: null, awarded: 20 };
    },
  },
  {
    header: 'content-security-policy',
    weight: 25,
    recommendation: "Add Content-Security-Policy (at minimum: default-src 'self')",
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      const hasDefault = /\bdefault-src\b/i.test(value);
      const hasScript = /\bscript-src\b/i.test(value);
      if (!hasDefault && !hasScript) {
        return { status: 'warn', note: 'CSP missing default-src or script-src', awarded: 12 };
      }
      const scriptSrcMatch = value.match(/script-src\s+([^;]+)/i);
      const scriptSrc = scriptSrcMatch && scriptSrcMatch[1] ? scriptSrcMatch[1] : '';
      if (/'unsafe-inline'/i.test(scriptSrc)) {
        return { status: 'warn', note: "script-src contains 'unsafe-inline'", awarded: 12 };
      }
      return { status: 'pass', note: null, awarded: 25 };
    },
  },
  {
    header: 'x-frame-options',
    weight: 10,
    recommendation: 'Add X-Frame-Options: DENY (or use CSP frame-ancestors)',
    check: (value, all) => {
      const csp = all['content-security-policy'] ?? '';
      const hasFrameAncestors = /\bframe-ancestors\b/i.test(csp);
      if (!value && !hasFrameAncestors) {
        return { status: 'fail', note: 'No X-Frame-Options and no CSP frame-ancestors', awarded: 0 };
      }
      if (!value && hasFrameAncestors) {
        return { status: 'pass', note: 'Covered by CSP frame-ancestors', awarded: 10 };
      }
      const ok = /^(DENY|SAMEORIGIN)$/i.test(value!.trim());
      return ok
        ? { status: 'pass', note: null, awarded: 10 }
        : { status: 'warn', note: 'Unexpected value', awarded: 5 };
    },
  },
  {
    header: 'x-content-type-options',
    weight: 10,
    recommendation: 'Add X-Content-Type-Options: nosniff',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^nosniff$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 10 }
        : { status: 'warn', note: 'Should be exactly "nosniff"', awarded: 5 };
    },
  },
  {
    header: 'referrer-policy',
    weight: 10,
    recommendation: 'Add Referrer-Policy (e.g. strict-origin-when-cross-origin)',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      if (/unsafe-url/i.test(value)) {
        return { status: 'warn', note: 'Value "unsafe-url" leaks full URLs', awarded: 5 };
      }
      return { status: 'pass', note: null, awarded: 10 };
    },
  },
  {
    header: 'permissions-policy',
    weight: 10,
    recommendation: 'Add Permissions-Policy to disable unused browser features',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return { status: 'pass', note: null, awarded: 10 };
    },
  },
  {
    header: 'cross-origin-opener-policy',
    weight: 5,
    recommendation: 'Add Cross-Origin-Opener-Policy: same-origin',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^same-origin$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 5 }
        : { status: 'warn', note: 'Recommend same-origin', awarded: 2 };
    },
  },
  {
    header: 'cross-origin-resource-policy',
    weight: 5,
    recommendation: 'Add Cross-Origin-Resource-Policy: same-origin or same-site',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^(same-origin|same-site)$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 5 }
        : { status: 'warn', note: 'Recommend same-origin or same-site', awarded: 2 };
    },
  },
];

const INFO_LEAK_HEADERS = ['server', 'x-powered-by'] as const;

export function gradeHeaders(rawHeaders: Record<string, string>): SecurityGrade {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;

  const checks: Record<string, HeaderCheck> = {};
  const pendingRecs: { rec: string; missing: number }[] = [];
  let score = 0;

  for (const rule of RULES) {
    const value = headers[rule.header] ?? null;
    const { status, note, awarded } = rule.check(value, headers);
    score += awarded;
    checks[rule.header] = { present: value !== null, value, status, note };
    if (awarded < rule.weight) {
      pendingRecs.push({ rec: rule.recommendation, missing: rule.weight - awarded });
    }
  }

  const present = INFO_LEAK_HEADERS.filter((h) => headers[h] != null);
  let leakAwarded: number;
  let leakStatus: HeaderStatus;
  let leakNote: string | null;
  if (present.length === 0) {
    leakAwarded = 5;
    leakStatus = 'pass';
    leakNote = null;
  } else if (present.length === 1) {
    leakAwarded = 2;
    leakStatus = 'warn';
    leakNote = `${present[0]} reveals server software`;
  } else {
    leakAwarded = 0;
    leakStatus = 'fail';
    leakNote = 'Both Server and X-Powered-By reveal server software';
  }
  score += leakAwarded;
  checks['server-info-leak'] = {
    present: present.length > 0,
    value: present.map((h) => `${h}: ${headers[h]}`).join('; ') || null,
    status: leakStatus,
    note: leakNote,
  };
  if (leakAwarded < 5) {
    pendingRecs.push({
      rec: 'Remove or obfuscate Server and X-Powered-By headers',
      missing: 5 - leakAwarded,
    });
  }

  const grade: SecurityGrade['grade'] =
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  return {
    grade,
    score,
    headers: checks,
    recommendations: pendingRecs.sort((a, b) => b.missing - a.missing).map((r) => r.rec),
  };
}
