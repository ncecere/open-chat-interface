import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, parseArgs } from './a11y-audit/lib/args.mjs';

test('with no arguments the base URL comes from E2E_BASE_URL and the rest are the defaults', () => {
  const options = parseArgs([], { E2E_BASE_URL: 'http://127.0.0.1:4699/' });
  assert.equal(options.baseUrl, 'http://127.0.0.1:4699');
  assert.equal(options.matrix, 'standard');
  assert.deepEqual(options.languages, DEFAULTS.languages);
  assert.match(options.out, /docs\/accessibility$/);
});

test('--base-url and --out beat the environment, in both spellings', () => {
  const options = parseArgs(['--base-url', 'http://a.test:1', '--out=/tmp/x'], {
    E2E_BASE_URL: 'http://b.test',
  });
  assert.equal(options.baseUrl, 'http://a.test:1');
  assert.equal(options.out, '/tmp/x');
});

test('lists are split, and a list can name a single value', () => {
  const options = parseArgs(['--roles', 'user', '--languages=en,ar-XB', '--views', '1280, 320']);
  assert.deepEqual(options.roles, ['user']);
  assert.deepEqual(options.languages, ['en', 'ar-XB']);
  assert.deepEqual(options.views, ['1280', '320']);
});

test('a mistake is an error that says what, not a silently ignored flag', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown option --bogus/);
  assert.throws(() => parseArgs(['--out']), /needs a value/);
  assert.throws(() => parseArgs(['--out', '--matrix']), /needs a value/);
  assert.throws(() => parseArgs(['--concurrency', '0']), /whole number/);
  assert.throws(() => parseArgs(['--base-url', 'not a url']), /not a URL/);
});

test('switches take no value', () => {
  assert.equal(parseArgs(['--no-walkthroughs']).noWalkthroughs, true);
  assert.equal(parseArgs(['--help']).help, true);
});
