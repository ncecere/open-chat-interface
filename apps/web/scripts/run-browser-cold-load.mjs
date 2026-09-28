import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// New browser session per trial: empty frontend HTTP cache, warm API/database.
// Authentication is real; obtaining a cookie beforehand excludes login from
// the navigation measurement. A separate UI login smoke test is required.
const [metadataPath] = process.argv.slice(2);
assert(metadataPath, 'Usage: node run-browser-cold-load.mjs metadata.json');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
assert.equal(metadata.urls.api, 'http://127.0.0.1:4180');
assert.equal(metadata.urls.baseline, 'http://127.0.0.1:4179');
assert.equal(metadata.urls.candidate, 'http://127.0.0.1:4178');
const credentials = JSON.parse(
  readFileSync(join(dirname(metadataPath), 'credentials.json'), 'utf8'),
);
const response = await fetch(`${metadata.urls.api}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: metadata.urls.candidate },
  body: JSON.stringify(credentials),
});
assert(response.ok, `Fixture authentication failed (${response.status})`);
const cookies = response.headers.getSetCookie().map((header) => {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const split = pair.indexOf('=');
  return {
    name: pair.slice(0, split),
    value: pair.slice(split + 1),
    domain: '127.0.0.1',
    path: '/',
    httpOnly: attributes.some((part) => part.toLowerCase() === 'httponly'),
    secure: false,
    sameSite: 'Lax',
  };
});
assert(
  cookies.some((cookie) => cookie.name.includes('session_token')),
  'No authenticated fixture cookie',
);
const output = mkdtempSync(join(tmpdir(), 'oci-cold-results-'));
const cookieFile = join(output, 'private-cookies.json');
writeFileSync(cookieFile, JSON.stringify(cookies), { mode: 0o600 });
const probe = fileURLToPath(new URL('./browser-performance-probe.js', import.meta.url));
const rows = [];
function browser(session, ...args) {
  const value = JSON.parse(
    execFileSync('agent-browser', ['--session', session, '--json', ...args], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  assert(value.success, value.error ?? 'Browser command failed');
  return value.data?.result ?? value.data;
}
try {
  for (let trial = 0; trial < 10; trial++) {
    const variant = (trial + Math.floor(trial / 2)) % 2 === 0 ? 'baseline' : 'candidate';
    const session = `oci-cold-${metadata.databaseName.slice(-8)}-${trial}`;
    try {
      browser(
        session,
        '--allowed-domains',
        '127.0.0.1',
        '--init-script',
        probe,
        'cookies',
        'set',
        '--curl',
        cookieFile,
        '--domain',
        '127.0.0.1',
      );
      const scenario = metadata.scenarios.find((item) => item.label === `cold-load-${variant}`);
      browser(session, 'open', metadata.urls[variant] + scenario.path);
      browser(
        session,
        'wait',
        '--fn',
        'Boolean(window.__ociPerformance?.modelReadyAt) && Boolean(window.__ociPerformance?.composerReadyAt)',
      );
      browser(session, 'focus', 'textarea[aria-label="Message input"]');
      browser(session, 'press', 'x');
      browser(session, 'wait', '--fn', 'window.__ociPerformance.keys.length > 0');
      const result = browser(
        session,
        'eval',
        `({ ...window.__ociPerformance, typed: document.querySelector('textarea[aria-label="Message input"]').value === 'x', scripts: performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname.endsWith('.js')).map(e => ({ transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize })) })`,
      );
      assert(result.typed && result.pageErrors === 0, 'Composer not usable');
      assert(
        result.scripts.length > 0 && result.scripts.every((item) => item.transfer > item.encoded),
        'Script cache was not cold',
      );
      const row = {
        trial,
        variant,
        composerReadyMs: result.composerReadyAt,
        modelReadyMs: result.modelReadyAt,
        keyToFrameMs: result.keys[0].keyToFrameMs,
        scriptRequests: result.scripts.length,
        scriptDecodedBytes: result.scripts.reduce((sum, item) => sum + item.decoded, 0),
        scriptTransferBytes: result.scripts.reduce((sum, item) => sum + item.transfer, 0),
        userAgent: result.userAgent,
        viewport: result.viewport,
      };
      rows.push(row);
      writeFileSync(
        join(output, 'summary.json'),
        JSON.stringify({ cache: 'cold-browser/warm-backend', rows }, null, 2),
        { mode: 0o600 },
      );
      console.log(JSON.stringify(row));
    } finally {
      browser(session, 'close');
    }
  }
} finally {
  rmSync(cookieFile, { force: true });
}
console.log(`Cold-load measurement artifacts: ${output}`);
