// A whole run of tools/scale/cluster.sh against fakes: a `kubectl` and a `dev-env` on PATH that
// answer from canned data and log every call. Nothing reaches a cluster. This checks the order of
// the steps and the paths the dry run cannot show: following the pod, scaling up when generation
// ends, copying results, the watcher's abort, a failing phase, a signal, and what happens when
// teardown leaves something behind.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const GIB = 1024 ** 3;
const POD = 'scale-t1-scale-run-abc12';

const FAKE_KUBECTL = `#!/bin/bash
D="$FAKE_DIR"
echo "$*" >> "$D/calls.log"
args=" $* "
tick() { local n; n=$(cat "$D/n-$1" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$D/n-$1"; echo "$n"; }
case "$args" in
  *" config current-context "*) echo "admin@bitop-talos" ;;
  *" get nodes -o json "*) cat "$D/nodes.json" ;;
  *"/proxy/stats/summary"*) cat "$D/summary.json" ;;
  *"/readyz/etcd"*) echo ok ;;
  *"get --raw /metrics"*)
    n=$(tick metrics)
    for le in 0.005:90 0.025:99 0.1:100 +Inf:100; do
      echo "etcd_request_duration_seconds_bucket{operation=\\"get\\",type=\\"pods\\",le=\\"\${le%%:*}\\"} $((n * \${le##*:}))"
    done ;;
  *" get pv -o "*) printf 'local-dev\\t10Gi\\ttalos-cp-1\\n' ;;
  *" get configmap env-"*"image-tag"*) echo dev-0123456789ab ;;
  *" get configmap env-"*"app-url"*) echo http://localhost:18123 ;;
  *" get deployment/"*|*" get service/"*|*" get secret/"*) echo "object" ;;
  *" get pod scale-t1-pg-1 "*) cat "$D/pod-node" 2>/dev/null || echo talos-cp-1 ;;
  *" get pvc scale-t1-pg-1 "*) echo talos-cp-1 ;;
  *" patch "*) echo patched ;;
  *" exec "*"show max_connections"*) echo 400 ;;
  *" exec "*" df -Pk"*)
    echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
    echo "/dev/loop3 5242880 1048576 4194304 20% /var/lib/postgresql/data" ;;
  *" exec "*"psql"*) echo "360.5|364.2" ;;
  *" get pods -l app.kubernetes.io/instance="*) ;;
  *" get pods -l dev.bitop.dev/env=scale-t1,app.kubernetes.io/name=scale-run "*)
    n=$(tick pod); total=$(wc -l < "$D/pod-states" | tr -d ' ')
    [ "$n" -le "$total" ] || n="$total"
    sed -n "\${n}p" "$D/pod-states" ;;
  *" apply "*) cat > "$D/applied-$(tick apply).yaml"; echo applied ;;
  *" wait "*|*" scale "*|*" set "*|*" rollout "*) echo ok ;;
  *" cp "*)
    dest=""; prev=""
    for a in "$@"; do if [ "$prev" = "${POD}:/results" ]; then dest="$a"; fi; prev="$a"; done
    mkdir -p "$dest"; echo '{"profile":"tiny"}' > "$dest/report.json"; echo "# report" > "$dest/report.md"
    echo '{}' > "$dest/k6-main.json" ;;
  *" logs "*) echo "error: connect postgres://postgres:secretpw@scale-t1-pg-rw:5432/oci refused"; echo "fine line" ;;
  *" describe "*) echo "Name: ${POD}" ;;
  *" delete jobs "*) echo "job deleted" ;;
  *" get all,pvc"*) if [ -f "$D/torn-down" ]; then :; else echo "pod/scale-t1-pg-1"; fi ;;
  *) echo "fake kubectl: unexpected call: $args" >&2; exit 99 ;;
esac
`;

const FAKE_DEVENV = `#!/bin/bash
echo "$*" >> "$FAKE_DIR/devenv.log"
case "$1 $2" in
  "up --help") echo "usage: dev-env up [--pg-size PG_SIZE] [--pg-node PG_NODE]" ;;
  "list oci") echo "PROJECT  NAME  REF  IMAGES  EXPIRES IN" ;;
  "up oci") : ;;
  "down oci") if [ ! -f "$FAKE_DIR/down-leaves-objects" ]; then touch "$FAKE_DIR/torn-down"; fi ;;
  *) echo "fake dev-env: unexpected: $*" >&2; exit 99 ;;
esac
`;

const node = (name) => ({
  metadata: { name },
  status: {
    capacity: { cpu: '8', memory: '32Gi' },
    conditions: [
      { type: 'MemoryPressure', status: 'False' },
      { type: 'DiskPressure', status: 'False' },
      { type: 'PIDPressure', status: 'False' },
      { type: 'Ready', status: 'True' },
    ],
    nodeInfo: {
      kernelVersion: '6.12.43-talos',
      osImage: 'Talos (v1.11.0)',
      architecture: 'amd64',
      kubeletVersion: 'v1.34.0',
    },
  },
});

const ALL_DONE =
  'extract:0 generate:0 environment:0 wait-api:0 wait-background:0 warm:0 baseline:0 main:0 collect-main:0 retention:0 collect-retention:0 render:0';
const SUCCESS_STATES = [
  `${POD} Pending hold:`,
  `${POD} Running extract:0 generate: hold:`,
  `${POD} Running extract:0 generate:0 environment:0 wait-api: hold:`,
  `${POD} Running ${ALL_DONE} hold:2026-10-14T00:00:00Z`,
];

let sandbox;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'oci-scale-run-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [
    ['kubectl', FAKE_KUBECTL],
    ['dev-env', FAKE_DEVENV],
  ]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  // helm, docker, flux and talosctl are never wanted, in any run.
  for (const name of ['helm', 'docker', 'flux', 'talosctl']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} must not be called" >&2\nexit 97\n`);
    chmodSync(join(bin, name), 0o755);
  }
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

function scenario(states = SUCCESS_STATES) {
  const dir = mkdtempSync(join(sandbox, 'run-'));
  const results = join(dir, 'results');
  writeFileSync(
    join(dir, 'nodes.json'),
    JSON.stringify({ items: ['talos-cp-1', 'talos-cp-2', 'talos-cp-3'].map(node) }),
  );
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      node: {
        cpu: { usageNanoCores: 800_000_000 },
        memory: { availableBytes: 20 * GIB },
        fs: { availableBytes: 600 * GIB, capacityBytes: 930 * GIB, usedBytes: 330 * GIB },
      },
    }),
  );
  writeFileSync(join(dir, 'pod-states'), `${states.join('\n')}\n`);
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir,
    results,
    calls: () => read('calls.log').trim().split('\n').filter(Boolean),
    devenv: () => read('devenv.log').trim().split('\n').filter(Boolean),
    read,
  };
}

function environment(s) {
  return {
    PATH: `${join(sandbox, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(sandbox, 'home'),
    FAKE_DIR: s.dir,
    DEVENV: join(sandbox, 'bin/dev-env'),
    KUBECONFIG_DEV: join(sandbox, 'no-such-kubeconfig'),
    SCALE_INTERVAL_SECONDS: '0.2',
    SCALE_POLL_SECONDS: '0.3',
    SCALE_VERIFY_WAIT_SECONDS: '1',
  };
}

const args = (s, ...extra) => [
  SCRIPT,
  '--profile',
  'tiny',
  '--name',
  'scale-t1',
  '--window-seconds',
  '1',
  '--results',
  s.results,
  ...extra,
];

function run(s, ...extra) {
  const result = spawnSync('bash', args(s, ...extra), {
    encoding: 'utf8',
    env: environment(s),
    timeout: 180_000,
    cwd: ROOT,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const index = (calls, pattern) => calls.findIndex((c) => pattern.test(c));

test('a full run: steps in order, results copied, teardown verified', () => {
  const s = scenario();
  const result = run(s);
  assert.equal(result.status, 0, result.out);
  const calls = s.calls();
  const order = [
    /config current-context/, // preflight
    /patch cluster\.postgresql\.cnpg\.io scale-t1-pg/,
    /scale deployment\/\S+-api deployment\/\S+-worker --replicas=0/,
    /apply --server-side .* -f -/,
    /rollout status deployment\/scale-t1-scale-stub/,
    /scale deployment\/scale-t1-open-chat-interface-api --replicas=1/, // after generation
    / cp scale-t1-scale-run-abc12:\/results /,
    /delete jobs -l dev\.bitop\.dev\/env=scale-t1/,
    /get all,pvc,secret,configmap,clusters\.postgresql\.cnpg\.io,serviceaccounts -l dev\.bitop\.dev\/env=scale-t1 -o name/,
  ];
  let previous = -1;
  for (const pattern of order) {
    const at = index(calls.slice(previous + 1), pattern);
    assert.ok(at >= 0, `${pattern} came after the previous step`);
    previous += at + 1;
  }
  // dev-env: pinned creation, then removal.
  const devenv = s.devenv();
  assert.match(
    devenv.join('\n'),
    /up oci scale-t1 --ref \S+ --ttl 2h --pg-size 5Gi --pg-node talos-cp-1/,
  );
  assert.match(devenv[devenv.length - 1], /^down oci scale-t1$/);
  assert.match(result.out, /Phase generate finished/);
  assert.match(result.out, /Teardown verified: nothing remains/);

  // Results: the run directory and the two report files.
  const dir = join(s.results, `tiny-cluster-${new Date().toISOString().slice(0, 10)}`);
  assert.ok(existsSync(join(dir, 'report.json')));
  assert.ok(existsSync(`${dir}.md`) && existsSync(`${dir}.json`));
  assert.ok(existsSync(join(dir, 'preflight.json')));
  assert.ok(readFileSync(join(dir, 'watch.jsonl'), 'utf8').length > 0, 'the watcher logged');
  assert.match(readFileSync(join(dir, 'teardown.txt'), 'utf8'), /Teardown verified/);
});

test('every kubectl call of a whole run is in dev-oci, never all namespaces, and no helm or docker', () => {
  const s = scenario();
  assert.equal(run(s).status, 0);
  const calls = s.calls();
  assert.ok(calls.length > 40, `${calls.length} calls`);
  for (const call of calls) {
    assert.match(call, /^--kubeconfig \S+ --request-timeout=\d+s -n dev-oci /, call);
    assert.doesNotMatch(call, /(^|\s)(-A|--all-namespaces)(\s|$)/, call);
    assert.equal([...call.matchAll(/(^|\s)(-n|--namespace)(\s|=)/g)].length, 1, call);
  }
  // The password in the fake logs never reaches the saved log.
  const dir = join(s.results, `tiny-cluster-${new Date().toISOString().slice(0, 10)}`);
  const saved = readFileSync(join(dir, 'pod.log'), 'utf8');
  assert.doesNotMatch(saved, /secretpw/);
  assert.match(saved, /postgres:\/\/\*\*\*@/);
});

test('the applied manifests are the rendered ones: labelled, and the secret never printed', () => {
  const s = scenario();
  const result = run(s);
  assert.equal(result.status, 0, result.out);
  const applied = readdirSync(s.dir).filter((f) => f.startsWith('applied-'));
  assert.equal(applied.length, 5, 'secret, two ConfigMaps, stub, run Job');
  for (const file of applied) {
    assert.match(readFileSync(join(s.dir, file), 'utf8'), /dev\.bitop\.dev\/env: scale-t1/, file);
  }
  const secret = applied
    .map((f) => readFileSync(join(s.dir, f), 'utf8'))
    .find((t) => t.includes('kind: Secret'));
  const token = /METRICS_TOKEN: "([0-9a-f]+)"/.exec(secret)?.[1];
  assert.equal(token?.length, 48);
  assert.ok(!result.out.includes(token), 'the token was printed');
  assert.ok(!s.calls().some((c) => c.includes(token)), 'the token was on a kubectl command line');
});

test('the fire drill: a forced threshold aborts, the Job is deleted, the environment removed, exit 1', () => {
  // The pod never finishes, so only the watcher can end the run.
  const s = scenario([`${POD} Running extract:0 generate: hold:`]);
  const result = run(s, '--threshold', 'etcdFsyncAbortOnceMs=0');
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /the watcher aborted the run/);
  const calls = s.calls();
  assert.ok(calls.some((c) => / delete jobs -l dev\.bitop\.dev\/env=scale-t1/.test(c)));
  assert.match(s.devenv().at(-1), /^down oci scale-t1$/);
  assert.match(result.out, /Teardown verified/);
  const dir = join(s.results, `tiny-cluster-${new Date().toISOString().slice(0, 10)}`);
  assert.match(readFileSync(join(dir, 'watcher-abort.json'), 'utf8'), /etcd-fsync-spike/);
  assert.match(readFileSync(join(dir, 'teardown.txt'), 'utf8'), /Teardown verified/);
});

test('--keep-on-abort keeps the environment after a failure, and says how to remove it', () => {
  const s = scenario([`${POD} Running extract:0 generate: hold:`]);
  const result = run(s, '--threshold', 'etcdFsyncAbortOnceMs=0', '--keep-on-abort');
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /Keeping scale-t1 until its TTL/);
  assert.ok(!s.devenv().some((c) => c.startsWith('down ')), 'dev-env down was not run');
});

test('a failing phase saves its log (redacted), tears down, and exits 1', () => {
  const s = scenario([`${POD} Pending hold:`, `${POD} Running extract:0 generate:1 hold:`]);
  const result = run(s);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /phase generate failed with status 1/);
  const dir = join(s.results, `tiny-cluster-${new Date().toISOString().slice(0, 10)}`);
  const log = readFileSync(join(dir, 'failed-generate.log'), 'utf8');
  assert.match(log, /refused/);
  assert.doesNotMatch(log, /secretpw/);
  assert.match(s.devenv().at(-1), /^down oci scale-t1$/);
  assert.ok(
    !s.calls().some((c) => / scale deployment\/\S+-api --replicas=1/.test(c)),
    'the API stays down',
  );
});

test('a signal during the run still tears everything down', async () => {
  // The pod never finishes, so the script is still following it when the signal arrives.
  const s = scenario([`${POD} Running extract:0 generate: hold:`]);
  const child = spawn('bash', args(s), { env: environment(s), cwd: ROOT, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 60_000;
  while (!s.calls().some((c) => / apply /.test(c)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    s.calls().some((c) => / apply /.test(c)),
    'the run reached the workload',
  );
  child.kill('SIGTERM');
  const code = await exited;
  assert.equal(code, 143);
  assert.match(s.devenv().at(-1), /^down oci scale-t1$/);
  assert.ok(s.calls().some((c) => / delete jobs -l /.test(c)));
  assert.ok(existsSync(join(s.dir, 'torn-down')));
});

test('objects left behind make the run fail loudly, even when the run itself worked', () => {
  const s = scenario();
  writeFileSync(join(s.dir, 'down-leaves-objects'), '');
  const result = run(s);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /NOT CLEAN/);
  assert.match(result.out, /objects remain: pod\/scale-t1-pg-1/);
});

test('a database that landed on talos-cp-2 stops the run before any load, and is torn down', () => {
  const s = scenario();
  writeFileSync(join(s.dir, 'pod-node'), 'talos-cp-2\n');
  const result = run(s);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /the database is not where it was pinned/);
  assert.match(result.out, /talos-cp-2/);
  assert.match(s.devenv().at(-1), /^down oci scale-t1$/);
  assert.ok(
    !s.calls().some((c) => / (patch|apply|scale) /.test(c)),
    'nothing was changed before the check',
  );
});

test('a failed preflight creates nothing and tears nothing down', () => {
  const s = scenario();
  const bad = JSON.parse(readFileSync(join(s.dir, 'nodes.json'), 'utf8'));
  bad.items[1].status.conditions[1].status = 'True';
  writeFileSync(join(s.dir, 'nodes.json'), JSON.stringify(bad));
  const result = run(s);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /\[FAIL\] nodes/);
  assert.deepEqual(
    s.devenv().filter((c) => !c.startsWith('list ')),
    [],
    'dev-env up or down ran',
  );
  assert.ok(!s.calls().some((c) => / (apply|patch|scale|delete) /.test(c)));
});

test('--preflight-only reads and stops', () => {
  const s = scenario();
  const result = run(s, '--preflight-only');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Preflight passed/);
  assert.deepEqual(
    s.devenv().filter((c) => !c.startsWith('list ')),
    [],
  );
  assert.ok(!s.calls().some((c) => / (apply|patch|scale|delete|set|exec) /.test(c)));
});
