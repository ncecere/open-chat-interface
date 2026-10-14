// tools/scale/cluster.sh without a cluster: its argument rules, and `--dry-run`, which must print
// every step and call none of kubectl, helm, docker, dev-env, flux or talosctl. Those names are
// stubs on PATH that fail and leave a mark if they are ever run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools/scale/cluster.sh');
const FORBIDDEN = ['kubectl', 'helm', 'docker', 'dev-env', 'flux', 'talosctl'];

let sandbox;
let stubs;
let marks;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'oci-scale-cluster-'));
  stubs = join(sandbox, 'bin');
  marks = join(sandbox, 'marks');
  mkdirSync(stubs);
  mkdirSync(marks);
  for (const name of FORBIDDEN) {
    const stub = join(stubs, name);
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$0 $*" >> "${marks}/${name}"\necho "${name} must not be called" >&2\nexit 97\n`,
    );
    chmodSync(stub, 0o755);
  }
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function run(args, extraEnv = {}) {
  const home = join(sandbox, 'home');
  mkdirSync(home, { recursive: true });
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      // The stubs first; the real kubectl, if this machine has one, is never reached.
      PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      ...extraEnv,
    },
    timeout: 120_000,
    cwd: ROOT,
  });
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const calledAnyForbidden = () => readdirSync(marks);
const dry = (...args) => run(['--dry-run', '--results', join(sandbox, 'results'), ...args]);

test('bash -n and shellcheck accept the script', () => {
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const lint = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
  assert.equal(
    lint.error,
    undefined,
    'shellcheck is not installed (CI images have it; install it to run this test)',
  );
  assert.equal(lint.status, 0, lint.stdout);
});

test('--help prints the usage and touches nothing', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.out, /--profile/);
  assert.match(result.out, /--yes-large/);
  assert.match(result.out, /--dry-run/);
  assert.deepEqual(calledAnyForbidden(), []);
});

test('a dry run for tiny prints every step and calls nothing', () => {
  const result = dry('--profile', 'tiny', '--name', 'scale-t1');
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(calledAnyForbidden(), [], 'a forbidden command was called');
  for (const step of [
    /preflight/i,
    /dev-env up oci scale-t1 .*--pg-size 5Gi .*--pg-node talos-cp-1/,
    /pg-node/,
    /patch cluster\.postgresql\.cnpg\.io scale-t1-pg/,
    /scale deployment\/scale-t1-open-chat-interface-api deployment\/scale-t1-open-chat-interface-worker --replicas=0/,
    /set env deployment\/scale-t1-open-chat-interface-api/,
    /set env deployment\/scale-t1-open-chat-interface-web TRUSTED_PROXIES=private_ranges/,
    /apply .* -f -/,
    /stub/i,
    /generate the dataset/i,
    /watcher/i,
    /scale deployment\/scale-t1-open-chat-interface-api --replicas=1/,
    /kubectl .* cp scale-t1-scale-run-\S+:\/results/,
    /delete jobs -l dev\.bitop\.dev\/env=scale-t1/,
    /dev-env down oci scale-t1/,
    /verify/i,
  ]) {
    assert.match(result.out, step);
  }
  assert.match(result.out, /dry run: nothing was created/i);
});

test('every kubectl line a dry run prints is scoped to dev-oci, none to all namespaces', () => {
  const result = dry('--profile', 'small', '--name', 'scale-s1', '--db-node', 'talos-cp-3');
  assert.equal(result.status, 0, result.out);
  const lines = result.out.split('\n').filter((line) => line.includes('+ kubectl'));
  assert.ok(lines.length > 20, `${lines.length} kubectl lines`);
  for (const line of lines) {
    assert.match(line, /\+ kubectl -n dev-oci /, line);
    assert.doesNotMatch(line, /(^|\s)(-A|--all-namespaces)(\s|$)/, line);
    assert.equal([...line.matchAll(/(^|\s)(-n|--namespace)(\s|=)/g)].length, 1, line);
  }
  assert.match(result.out, /--pg-size 15Gi .*--pg-node talos-cp-3/);
  // The load side goes to the other node.
  assert.match(result.out, /talos-cp-1/);
});

test('a dry run prints no secret', () => {
  const result = dry('--profile', 'tiny', '--name', 'scale-t1');
  assert.doesNotMatch(
    result.out,
    /[0-9a-f]{40,}/i,
    'a long hex string (a generated token?) was printed',
  );
  assert.doesNotMatch(result.out, /METRICS_TOKEN=\S/);
  assert.doesNotMatch(result.out, /PGPASSWORD|password=/i);
});

test('large needs --yes-large, a pinned database node, and prints the 150Gi plan', () => {
  const refused = dry('--profile', 'large', '--name', 'scale-l1', '--db-node', 'talos-cp-3');
  assert.equal(refused.status, 2);
  assert.match(refused.out, /--yes-large/);

  const unpinned = dry('--profile', 'large', '--name', 'scale-l1', '--yes-large');
  assert.equal(unpinned.status, 2);
  assert.match(unpinned.out, /--db-node/);

  const sata = dry(
    '--profile',
    'large',
    '--name',
    'scale-l1',
    '--yes-large',
    '--db-node',
    'talos-cp-2',
  );
  assert.equal(sata.status, 2);
  assert.match(sata.out, /talos-cp-2/);

  const ok = dry(
    '--profile',
    'large',
    '--name',
    'scale-l1',
    '--yes-large',
    '--db-node',
    'talos-cp-3',
  );
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /--ttl 8h .*--pg-size 150Gi .*--pg-node talos-cp-3/);
  assert.match(ok.out, /27000/, 'the Job deadline is the 8 h TTL minus 30 minutes');
  assert.deepEqual(calledAnyForbidden(), []);
});

test('medium needs a pinned node too; small and tiny default to cp-1', () => {
  assert.equal(dry('--profile', 'medium', '--name', 'scale-m1').status, 2);
  assert.equal(
    dry('--profile', 'medium', '--name', 'scale-m1', '--db-node', 'talos-cp-1').status,
    0,
  );
  assert.match(dry('--profile', 'small', '--name', 'scale-s1').out, /--pg-node talos-cp-1/);
});

test('bad arguments are refused with status 2 before anything happens', () => {
  const cases = [
    ['--profile', 'huge', '--name', 'scale-x'],
    ['--profile', 'tiny'],
    ['--profile', 'tiny', '--name', 'Scale_X'],
    ['--profile', 'tiny', '--name', 'x'],
    ['--profile', 'tiny', '--name', 'a'.repeat(21)],
    ['--profile', 'tiny', '--name', 'scale-x', '--replicas', '0'],
    ['--profile', 'tiny', '--name', 'scale-x', '--threshold', 'bogus=1'],
    ['--profile', 'tiny', '--name', 'scale-x', '--ttl', '90m'],
    ['--profile', 'tiny', '--name', 'scale-x', '--nonsense'],
    ['--profile', 'tiny', '--name', 'scale-x', '--db-node'],
  ];
  for (const args of cases) {
    const result = dry(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.out}`);
  }
  assert.deepEqual(calledAnyForbidden(), []);
});

test('a forced threshold (the fire drill) reaches the watcher', () => {
  const result = dry(
    '--profile',
    'tiny',
    '--name',
    'scale-t1',
    '--threshold',
    'etcdFsyncAbortOnceMs=0',
  );
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /cluster-watch\.mjs .*--threshold etcdFsyncAbortOnceMs=0/);
});

test('--preflight-only stops after the preflight and creates nothing', () => {
  const result = dry('--profile', 'tiny', '--name', 'scale-t1', '--preflight-only');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /cluster-preflight\.mjs run/);
  assert.doesNotMatch(result.out, /dev-env up/);
});

test('the script reaches the cluster only through its guarded helpers', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    // The helpers themselves, and the usage text, are where the names may appear.
    .replace(/^k\(\) \{[\s\S]*?^\}\n/m, '')
    .replace(/^kq\(\) \{[\s\S]*?^\}\n/m, '')
    .replace(/^devenv\(\) \{[\s\S]*?^\}\n/m, '')
    .replace(/^usage\(\) \{[\s\S]*?^\}\n/m, '');
  for (const name of FORBIDDEN) {
    // At a command position: the start of a line, after ; | & or inside $( ) or backticks.
    const direct = new RegExp(`(^|[;|&\`]|\\$\\()\\s*${name.replace('-', '\\-')}\\s`, 'm');
    assert.doesNotMatch(code, direct, `${name} is invoked outside its helper`);
  }
  assert.doesNotMatch(code, /--all-namespaces/);
  assert.doesNotMatch(code, /\s-A\s/);
  assert.ok(!existsSync(join(ROOT, 'tools/scale/results/.cluster-test')), 'no stray files');
});
