// The CSP hash in nginx.conf must match the inline script in index.html.
//
// index.html carries one inline script - the pre-paint theme stamp - and the CSP
// allows it by hash rather than by 'unsafe-inline', so that one script is
// permitted and an injected one is not.
//
// The failure mode is why this check exists: edit the script, and the browser
// silently refuses to run it. Nothing 500s, nothing logs, no test goes red - a
// light-mode user just gets a dark flash on every page load, which is exactly
// the kind of small wrongness nobody files. The hash and the script have to be
// checked against each other by something that fails.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'web', 'dist', 'index.html'), 'utf8');
const conf = readFileSync(join(here, '..', 'nginx.conf'), 'utf8');

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
};

const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
check('index.html has exactly one inline script', scripts.length === 1,
      `${scripts.length} found`);

// The POLICY, not the file. Grepping the whole conf matched the comments
// explaining why 'unsafe-inline' is not used - prose that says the opposite of
// what it appears to say to a regex.
const header = conf.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/);
check('a CSP is actually set', !!header);
const csp = header?.[1] ?? '';
const directive = (name) =>
  csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' ')) ?? '';

const want = `sha256-${createHash('sha256').update(scripts[0]?.[1] ?? '').digest('base64')}`;
check('the CSP allows that exact script', csp.includes(`'${want}'`), want);

// Without these the check above passes trivially against a policy that allows
// everything anyway - which is the state it exists to prevent.
check("script-src does not allow 'unsafe-inline'",
      !directive('script-src').includes("'unsafe-inline'"), directive('script-src'));
check("script-src does not allow 'unsafe-eval'",
      !directive('script-src').includes("'unsafe-eval'"));
check("connect-src is 'self' only - nowhere to exfiltrate to",
      directive('connect-src') === "connect-src 'self'", directive('connect-src'));

process.exit(bad ? 1 : 0);
