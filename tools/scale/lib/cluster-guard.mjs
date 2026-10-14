// Decisions of tools/scale/cluster.sh, kept pure so they are tested without a cluster
// (scripts/scale-cluster-guard.test.mjs): which kubectl calls are allowed, where the database may
// live, whether the cluster is quiet enough to start, when the watcher stops the run, and whether
// teardown left nothing behind. docs/dev/scale-harness.md ("Large on the cluster") explains why.

export const NAMESPACE = 'dev-oci';
export const ENV_LABEL = 'dev.bitop.dev/env';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Volume size and lifetime per profile. 150Gi for `large` is the profile's estimate (75 GB) times
 * 1.5 plus 10, as run.sh's disk check, and 75 % of the 200Gi pool quota, under the 85 % alert.
 * `pinRequired`: the database node must be named explicitly (its volume is node-local).
 */
const PLANS = {
  tiny: { pgSize: '5Gi', ttlHours: 2, pinRequired: false },
  small: { pgSize: '15Gi', ttlHours: 3, pinRequired: false },
  medium: { pgSize: '40Gi', ttlHours: 4, pinRequired: true },
  large: { pgSize: '150Gi', ttlHours: 8, pinRequired: true },
};

export function planFor(profile) {
  const plan = PLANS[profile];
  if (!plan)
    throw new Error(`Unknown profile "${profile}"; choose one of ${Object.keys(PLANS).join(', ')}`);
  return { ...plan };
}

/** The run Job stops 30 minutes before the environment's TTL, whoever is or is not watching. */
export const DEADLINE_MARGIN_SECONDS = 1800;

export function jobDeadlineSeconds(ttlHours) {
  const seconds = ttlHours * 3600 - DEADLINE_MARGIN_SECONDS;
  if (!Number.isFinite(ttlHours) || seconds <= 0)
    throw new Error(`The ttl of ${ttlHours} hours is too short for a run`);
  return seconds;
}

const UNITS = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };

/** Kubernetes binary quantities ("150Gi") and plain integers, as bytes. */
export function parseQuantity(text) {
  const match = /^(\d+)(Ki|Mi|Gi|Ti)?$/.exec(String(text ?? ''));
  if (!match)
    throw new Error(
      `Not a quantity: ${JSON.stringify(text)} (use a whole number and Ki, Mi, Gi or Ti)`,
    );
  return Number(match[1]) * (match[2] ? UNITS[match[2]] : 1);
}

// ---------------------------------------------------------------------------
// Scope guard
// ---------------------------------------------------------------------------

export class ScopeError extends Error {}
const refuse = (message) => {
  throw new ScopeError(message);
};

const VERBS = new Set([
  'get',
  'describe',
  'apply',
  'create',
  'delete',
  'patch',
  'set',
  'scale',
  'rollout',
  'wait',
  'exec',
  'cp',
  'logs',
  'annotate',
  'label',
  'top',
  'config',
]);
const CHANGING = new Set([
  'apply',
  'create',
  'delete',
  'patch',
  'set',
  'scale',
  'rollout',
  'label',
  'annotate',
]);
const OWN_PODS_ONLY = new Set(['exec', 'cp', 'logs']);

// Flags that change which cluster or identity kubectl uses; cluster.sh chooses the kubeconfig itself.
const FORBIDDEN_FLAGS = [
  '--context',
  '--kubeconfig',
  '--server',
  '-s',
  '--token',
  '--as',
  '--as-group',
  '--as-uid',
  '--cluster',
  '--user',
  '--username',
  '--password',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--insecure-skip-tls-verify',
  '--tls-server-name',
];

// Flags whose value is the next argument, so it is not mistaken for an object name.
const VALUE_FLAGS = new Set([
  '-o',
  '--output',
  '-l',
  '--selector',
  '-p',
  '--patch',
  '--patch-file',
  '-f',
  '--filename',
  '-c',
  '--container',
  '--type',
  '--timeout',
  '--for',
  '--from',
  '--keys',
  '--replicas',
  '--field-manager',
  '--raw',
  '--template',
  '-L',
  '--sort-by',
  '--tail',
  '--since',
  '--limit-bytes',
  '--field-selector',
  '--request-timeout',
  '--limits',
  '--requests',
  '--from-file',
  '--from-literal',
  '--type',
  '--retries',
]);

const NAMESPACE_WORDS = new Set(['ns', 'namespace', 'namespaces']);

// Kind and sub-command words that are not object names.
const WORDS = new Set([
  'deployment',
  'deployments',
  'deploy',
  'job',
  'jobs',
  'service',
  'services',
  'svc',
  'configmap',
  'configmaps',
  'cm',
  'secret',
  'secrets',
  'pod',
  'pods',
  'pvc',
  'persistentvolumeclaim',
  'persistentvolumeclaims',
  'cluster.postgresql.cnpg.io',
  'clusters.postgresql.cnpg.io',
  'cluster',
  'node',
  'nodes',
  'pv',
  'persistentvolume',
  'persistentvolumes',
  'events',
  'env',
  'resources',
  'image',
  'status',
  'restart',
  'undo',
  'history',
  'generic',
]);

const RAW_PATHS = [
  /^\/readyz(\/etcd)?$/,
  /^\/metrics$/,
  /^\/api\/v1\/nodes\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/proxy\/stats\/summary$/,
];

function takeFlags(args) {
  let namespace;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      // What follows is the command run inside the pod (kubectl exec), not kubectl's own flags.
      rest.push(...args.slice(i));
      break;
    }
    const name = arg.startsWith('--') ? arg.split('=')[0] : arg;
    if (arg === '-A' || /^-[A-Za-z]*A[A-Za-z]*$/.test(arg) || name === '--all-namespaces') {
      refuse(
        'all namespaces (-A, --all-namespaces) are never allowed; this tool works in dev-oci only',
      );
    }
    if (FORBIDDEN_FLAGS.includes(name)) {
      refuse(
        `${name} is not allowed: the cluster and identity come from the kubeconfig cluster.sh chose`,
      );
    }
    let value;
    if (arg === '-n' || arg === '--namespace') {
      value = args[++i] ?? '';
    } else if (arg.startsWith('--namespace=')) {
      value = arg.slice('--namespace='.length);
    } else if (/^-n[^-]/.test(arg)) {
      value = arg.slice(2);
    }
    if (value !== undefined) {
      if (value !== NAMESPACE)
        refuse(`namespace ${JSON.stringify(value)} is not allowed; only ${NAMESPACE}`);
      namespace = value;
      continue;
    }
    rest.push(arg);
    if (VALUE_FLAGS.has(arg) && i + 1 < args.length) rest.push(args[++i]);
  }
  return { namespace, rest };
}

/** Object-name arguments: everything that is neither a flag nor a flag's value. */
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function flagValues(args, long, short) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === long || arg === short) values.push(args[++i] ?? '');
    else if (arg.startsWith(`${long}=`)) values.push(arg.slice(long.length + 1));
    else if (short === '-l' && /^-l[^-]/.test(arg)) values.push(arg.slice(2));
  }
  return values;
}

function checkRaw(verb, rest) {
  const paths = flagValues(rest, '--raw');
  if (paths.length === 0) return;
  if (verb !== 'get' || paths.length !== 1 || !RAW_PATHS.some((re) => re.test(paths[0]))) {
    refuse(
      `--raw ${paths.join(' ')} is not on the list of readable paths (readyz, metrics, kubelet summary)`,
    );
  }
}

function checkNamespaceReads(tokens) {
  for (const token of tokens) {
    for (const part of token.split(',')) {
      if (NAMESPACE_WORDS.has(part.split('/')[0])) {
        refuse(`reading namespaces is not allowed (${JSON.stringify(token)})`);
      }
    }
  }
}

/** The object name in `name`, `kind/name` or `name:path` (kubectl cp), or null for a kind or word. */
function objectName(token) {
  const base = token.split(':')[0];
  return base.includes('/') ? base.slice(base.indexOf('/') + 1) : base;
}

function ownsName(token, env) {
  return objectName(token).startsWith(`${env}-`);
}

function checkDelete(rest, env) {
  if (rest.includes('--all') || rest.some((a) => a.startsWith('--all=')))
    refuse('delete --all is not allowed');
  const selectors = flagValues(rest, '--selector', '-l');
  const names = positionals(rest.slice(1));
  if (selectors.length > 0) {
    if (!selectors.every((s) => s.split(',').includes(`${ENV_LABEL}=${env}`))) {
      refuse(`delete by selector must include ${ENV_LABEL}=${env}`);
    }
    return;
  }
  const concrete = names.filter((n) => !WORDS.has(n));
  if (concrete.length === 0 || !concrete.every((n) => ownsName(n, env))) {
    refuse(
      `delete must name objects of the environment (names starting with ${env}-) or use the ${ENV_LABEL} label`,
    );
  }
}

function checkChange(verb, rest, env) {
  if (verb === 'apply') return; // The manifests are checked before they are piped in (checkManifests).
  // Assignments (KEY=value, label=value), kinds and sub-commands are not object names.
  const objects = positionals(rest.slice(1)).filter((t) => !t.includes('=') && !WORDS.has(t));
  if (objects.length === 0 || !objects.every((n) => ownsName(n, env))) {
    refuse(`${verb} may only name objects of the environment (names starting with ${env}-)`);
  }
}

function checkOwnPods(verb, rest, env) {
  const before = rest.slice(1);
  const selectors = flagValues(before, '--selector', '-l');
  if (selectors.length > 0) {
    if (!selectors.every((s) => s.split(',').includes(`${ENV_LABEL}=${env}`))) {
      refuse(`${verb} by selector must include the environment's label ${ENV_LABEL}=${env}`);
    }
    return;
  }
  // kubectl cp names a pod as `pod:path`; its other argument is a local path.
  const names = positionals(before).filter((n) => verb !== 'cp' || n.includes(':'));
  if (names.length === 0 || !names.every((n) => ownsName(n, env))) {
    refuse(`${verb} may only name pods of the environment (names starting with ${env}-)`);
  }
}

function checkSecretReads(verb, rest) {
  if (verb !== 'get') return;
  const tokens = positionals(rest.slice(1))
    .flatMap((t) => t.split(','))
    .map((t) => t.split('/')[0]);
  if (!tokens.some((t) => ['secret', 'secrets'].includes(t))) return;
  const output = flagValues(rest, '--output', '-o');
  if (!output.every((o) => o === 'name'))
    refuse('secrets may be listed with -o name only; their contents are never printed');
}

/**
 * The arguments for kubectl, with the namespace first. Throws ScopeError for anything that could
 * leave dev-oci or the environment `env` (the name given to dev-env). cluster.sh runs every kubectl
 * call through this; the watcher imports it too.
 */
export function scopeKubectl(args, { env } = {}) {
  for (const arg of args) {
    if (typeof arg !== 'string') refuse('every kubectl argument must be a string');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
    if (/[\u0000\n\r]/.test(arg)) refuse('control characters in a kubectl argument');
  }
  const { rest } = takeFlags(args);
  const verb = rest[0];
  if (!VERBS.has(verb)) refuse(`verb ${JSON.stringify(verb)} is not allowed`);
  if (verb === 'config') {
    if (rest.length !== 2 || rest[1] !== 'current-context')
      refuse('the only config command allowed is current-context');
    return ['-n', NAMESPACE, ...rest];
  }
  checkRaw(verb, rest);
  checkNamespaceReads(positionals(rest.slice(1)));
  checkSecretReads(verb, rest);
  if (CHANGING.has(verb) && !env)
    refuse(`${verb} needs the environment name (the objects it may change)`);
  if (env !== undefined && !/^[a-z][a-z0-9-]{1,19}$/.test(env))
    refuse(`${JSON.stringify(env)} is not an environment name`);
  if (verb === 'delete') checkDelete(rest, env);
  else if (CHANGING.has(verb)) checkChange(verb, rest, env);
  else if (env && OWN_PODS_ONLY.has(verb)) checkOwnPods(verb, rest, env);
  return ['-n', NAMESPACE, ...rest];
}

/**
 * Objects about to be applied: every one in dev-oci (or with no namespace, which the -n flag
 * fills), labelled with the environment, and named after it. `objects` come from cluster-yaml.mjs.
 */
export function checkManifests(objects, env) {
  const problems = [];
  for (const object of objects) {
    const where = `${object?.kind ?? '?'}/${object?.metadata?.name ?? '?'}`;
    const ns = object?.metadata?.namespace;
    if (ns !== undefined && ns !== NAMESPACE) problems.push(`${where}: namespace ${ns}`);
    if (object?.metadata?.labels?.[ENV_LABEL] !== env)
      problems.push(`${where}: missing label ${ENV_LABEL}=${env}`);
    if (!String(object?.metadata?.name ?? '').startsWith(`${env}-`))
      problems.push(`${where}: name does not start with ${env}-`);
  }
  if (problems.length > 0) throw new ScopeError(`Refusing to apply: ${problems.join('; ')}`);
  return objects;
}

// ---------------------------------------------------------------------------
// Pin: where the database volume lives
// ---------------------------------------------------------------------------

/** cp-2's local volumes are SATA, and every node runs etcd on its system disk. */
export const FORBIDDEN_DB_NODE = 'talos-cp-2';
export const DB_NODES = ['talos-cp-1', 'talos-cp-3'];

/**
 * phase 'requested': before `dev-env up`, is the node asked for acceptable? phase 'bound': after
 * it, is the node the volume really bound to the one asked for? A node that cannot be read is not
 * a pass.
 */
export function pinDecision({ profile, requestedNode, boundNode, phase = 'requested' }) {
  const problems = [];
  if (requestedNode === undefined || requestedNode === null || requestedNode === '') {
    if (planFor(profile).pinRequired)
      problems.push(`${profile} needs --db-node (one of ${DB_NODES.join(', ')})`);
  } else if (!DB_NODES.includes(requestedNode)) {
    problems.push(
      requestedNode === FORBIDDEN_DB_NODE
        ? `${FORBIDDEN_DB_NODE} is never used for the database volume (SATA, and etcd shares its system disk)`
        : `${requestedNode} is not an allowed database node (${DB_NODES.join(', ')})`,
    );
  }
  if (phase === 'bound') {
    if (!boundNode) problems.push('the node the database volume bound to could not be read');
    else if (boundNode === FORBIDDEN_DB_NODE)
      problems.push(`the volume bound to ${FORBIDDEN_DB_NODE}`);
    else if (requestedNode && boundNode !== requestedNode) {
      problems.push(`the volume bound to ${boundNode}, not the pinned ${requestedNode}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Thresholds and the watcher
// ---------------------------------------------------------------------------

/**
 * Starting values from the spec, to be replaced by baselines from the `medium` gate. A threshold is
 * crossed at its value, not above it: a reading equal to the limit stops the run.
 */
export const DEFAULT_THRESHOLDS = {
  etcdFsyncWarnMs: 10,
  etcdFsyncAbortMs: 25,
  etcdFsyncStrikes: 2,
  etcdFsyncAbortOnceMs: 100,
  volumeAbortFraction: 0.8,
  dbNodeFsFreeMinFraction: 0.2,
  maxBlindSamples: 3,
};

// Where the latency comes from. etcd's own WAL fsync histogram is the signal the spec names; if the
// only source is the apiserver's request latency (a proxy that includes more than the disk), the
// limits are looser. These looser values are placeholders until measured (open question 1).
const SOURCE_OVERRIDES = {
  'wal-fsync': {},
  'apiserver-request': { etcdFsyncWarnMs: 50, etcdFsyncAbortMs: 250, etcdFsyncAbortOnceMs: 1000 },
};

export function thresholdsFor(source) {
  if (!(source in SOURCE_OVERRIDES)) {
    throw new Error(
      `Unknown etcd source "${source}"; use ${Object.keys(SOURCE_OVERRIDES).join(' or ')}`,
    );
  }
  return { ...DEFAULT_THRESHOLDS, ...SOURCE_OVERRIDES[source] };
}

/** `name=value` pairs (the fire drill forces one to 0), checked against the known thresholds. */
export function parseThresholdOverrides(pairs) {
  const out = {};
  for (const pair of pairs) {
    const [name, text, ...more] = String(pair).split('=');
    const value = Number(text);
    if (
      !(name in DEFAULT_THRESHOLDS) ||
      text === undefined ||
      text === '' ||
      more.length > 0 ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw new Error(
        `Bad threshold ${JSON.stringify(pair)}; use name=number with name one of ${Object.keys(DEFAULT_THRESHOLDS).join(', ')}`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * One watcher per run. `evaluate(sample)` is called every 15 s with
 *   { etcd: { p99Ms, readyz, leaderChanges }, volume: { usedBytes },
 *     nodes: [{ name, ready, pressure: { memory, disk, pid }, fsFreeFraction }] }
 * and answers { action: 'ok' | 'warn' | 'abort', reasons: [{ code, detail }] }. A reading that is
 * null is a reading that could not be taken; three samples in a row with one missing abort.
 */
export function createWatcher({
  thresholds = DEFAULT_THRESHOLDS,
  volumeLimitBytes,
  pgSizeBytes,
  dbNode,
}) {
  const limit = volumeLimitBytes ?? pgSizeBytes * thresholds.volumeAbortFraction;
  if (!Number.isFinite(limit))
    throw new Error('createWatcher needs volumeLimitBytes or pgSizeBytes');
  let strikes = 0;
  let blind = 0;
  let leaderBaseline;
  const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

  return {
    evaluate(sample) {
      const aborts = [];
      const warns = [];
      const abort = (code, detail) => aborts.push({ code, detail });
      const etcd = sample.etcd ?? {};
      const dbEntry = (sample.nodes ?? []).find((n) => n.name === dbNode);
      const complete =
        isNumber(etcd.p99Ms) &&
        typeof etcd.readyz === 'boolean' &&
        isNumber(sample.volume?.usedBytes) &&
        isNumber(dbEntry?.fsFreeFraction) &&
        dbEntry?.pressure != null;
      blind = complete ? 0 : blind + 1;
      if (blind >= thresholds.maxBlindSamples) {
        abort('blind', `${blind} samples in a row were missing a reading; the watcher cannot see`);
      } else if (!complete) {
        warns.push({ code: 'blind-sample', detail: 'a reading could not be taken' });
      }

      if (etcd.readyz === false) abort('etcd-readyz', '/readyz/etcd is failing');
      if (isNumber(etcd.leaderChanges)) {
        if (leaderBaseline === undefined) leaderBaseline = etcd.leaderChanges;
        else if (etcd.leaderChanges > leaderBaseline) {
          abort(
            'etcd-leader-change',
            `etcd leader changes went from ${leaderBaseline} to ${etcd.leaderChanges}`,
          );
          leaderBaseline = etcd.leaderChanges;
        }
      }
      if (isNumber(etcd.p99Ms)) {
        const p99 = etcd.p99Ms;
        if (p99 >= thresholds.etcdFsyncAbortOnceMs) {
          abort(
            'etcd-fsync-spike',
            `etcd p99 ${p99} ms is at or above ${thresholds.etcdFsyncAbortOnceMs} ms`,
          );
        }
        if (p99 >= thresholds.etcdFsyncAbortMs) {
          strikes += 1;
          if (strikes >= thresholds.etcdFsyncStrikes && p99 < thresholds.etcdFsyncAbortOnceMs) {
            abort(
              'etcd-fsync',
              `etcd p99 ${p99} ms at or above ${thresholds.etcdFsyncAbortMs} ms ${strikes} samples in a row`,
            );
          } else if (strikes < thresholds.etcdFsyncStrikes) {
            warns.push({
              code: 'etcd-fsync-strike',
              detail: `etcd p99 ${p99} ms (strike ${strikes} of ${thresholds.etcdFsyncStrikes})`,
            });
          }
        } else {
          strikes = 0;
        }
        if (p99 >= thresholds.etcdFsyncWarnMs && p99 < thresholds.etcdFsyncAbortOnceMs) {
          warns.push({
            code: 'etcd-fsync-warn',
            detail: `etcd p99 ${p99} ms is at or above ${thresholds.etcdFsyncWarnMs} ms`,
          });
        }
      }
      if (isNumber(sample.volume?.usedBytes) && sample.volume.usedBytes >= limit) {
        abort(
          'volume',
          `the data volume holds ${sample.volume.usedBytes} bytes, at or above the limit of ${limit}`,
        );
      }
      const troubled = (sample.nodes ?? []).filter(
        (n) => n.ready === false || Object.values(n.pressure ?? {}).some(Boolean),
      );
      if (troubled.length > 0) {
        abort(
          'node-pressure',
          `${troubled.map((n) => n.name).join(', ')} not ready or under pressure`,
        );
      }
      if (
        isNumber(dbEntry?.fsFreeFraction) &&
        dbEntry.fsFreeFraction <= thresholds.dbNodeFsFreeMinFraction
      ) {
        abort(
          'db-node-fs',
          `${dbNode} filesystem is ${(dbEntry.fsFreeFraction * 100).toFixed(1)} % free, at or below ${thresholds.dbNodeFsFreeMinFraction * 100} %`,
        );
      }
      const reasons = aborts.length > 0 ? aborts : warns;
      return { action: aborts.length > 0 ? 'abort' : warns.length > 0 ? 'warn' : 'ok', reasons };
    },
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Both proposals from the spec ("needs measuring"): below half busy; 20 % of the disk free. */
export const PREFLIGHT_LIMITS = {
  poolRatioMax: 0.8,
  cpuBusyBelow: 0.5,
  dbNodeFsFreeMin: 0.2,
  minEtcdSamples: 10,
};

/**
 * readings: { context, environments, nodes: [{ name, ready, pressure, cpuBusyFraction, fsFreeBytes,
 * fsCapacityBytes }], pool: { allocatedBytes, capacityBytes } (the database node's), etcd: {
 * readyz, members, fsyncP99Ms: [samples over the window] } }. A reading that is null failed.
 */
export function decidePreflight(
  readings,
  {
    dbNode,
    loadNode,
    pgSizeBytes,
    contextPattern,
    limits = PREFLIGHT_LIMITS,
    etcdWarnMs = DEFAULT_THRESHOLDS.etcdFsyncWarnMs,
  },
) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const gib = (b) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
  const r = readings ?? {};

  add(
    'context',
    typeof r.context === 'string' && contextPattern.test(r.context),
    `kubectl context ${JSON.stringify(r.context ?? null)} must match ${contextPattern}`,
  );

  if (!Array.isArray(r.environments))
    add('environments', false, 'dev-env list oci could not be read');
  else
    add(
      'environments',
      r.environments.length === 0,
      r.environments.length === 0
        ? 'no environment exists in dev-oci'
        : `environments already exist: ${r.environments.join(', ')}`,
    );

  const nodes = Array.isArray(r.nodes) ? r.nodes : [];
  const names = nodes.map((n) => n.name);
  const missing = ['talos-cp-1', 'talos-cp-2', 'talos-cp-3'].filter((n) => !names.includes(n));
  const unwell = nodes.filter(
    (n) => n.ready !== true || !n.pressure || Object.values(n.pressure).some((v) => v !== false),
  );
  add(
    'nodes',
    nodes.length > 0 && missing.length === 0 && unwell.length === 0,
    missing.length > 0
      ? `nodes missing: ${missing.join(', ')}`
      : unwell.length > 0
        ? `not ready or under pressure (or unread): ${unwell.map((n) => n.name).join(', ')}`
        : `${names.join(', ')} are Ready with no memory, disk or PID pressure`,
  );

  const pool = r.pool;
  if (!pool || !num(pool.allocatedBytes) || !num(pool.capacityBytes) || pool.capacityBytes <= 0) {
    add(
      'pool',
      false,
      'the allocation of the local-dev pool on the database node could not be read',
    );
  } else {
    const ratio = (pool.allocatedBytes + pgSizeBytes) / pool.capacityBytes;
    add(
      'pool',
      ratio <= limits.poolRatioMax,
      `${dbNode} pool: ${gib(pool.allocatedBytes)} allocated + ${gib(pgSizeBytes)} requested of ${gib(pool.capacityBytes)} = ${ratio.toFixed(3)} (limit ${limits.poolRatioMax})`,
    );
  }

  const dbNodeReading = nodes.find((n) => n.name === dbNode);
  if (
    !dbNodeReading ||
    !num(dbNodeReading.fsFreeBytes) ||
    !num(dbNodeReading.fsCapacityBytes) ||
    dbNodeReading.fsCapacityBytes <= 0
  ) {
    add('db-node-fs', false, `the filesystem of ${dbNode} could not be read`);
  } else {
    const after = (dbNodeReading.fsFreeBytes - pgSizeBytes) / dbNodeReading.fsCapacityBytes;
    add(
      'db-node-fs',
      after >= limits.dbNodeFsFreeMin,
      `${dbNode} filesystem: ${gib(dbNodeReading.fsFreeBytes)} free of ${gib(dbNodeReading.fsCapacityBytes)}; ${(after * 100).toFixed(1)} % would stay free after the volume (need ${limits.dbNodeFsFreeMin * 100} %)`,
    );
  }

  const busyReadings = [dbNode, loadNode].map((name) => {
    const fraction = nodes.find((n) => n.name === name)?.cpuBusyFraction;
    return { name, fraction: num(fraction) ? fraction : null };
  });
  add(
    'cpu',
    busyReadings.every((b) => b.fraction !== null && b.fraction < limits.cpuBusyBelow),
    `${busyReadings
      .map(
        (b) => `${b.name} ${b.fraction === null ? 'unread' : `${(b.fraction * 100).toFixed(1)} %`}`,
      )
      .join(', ')} busy (need below ${limits.cpuBusyBelow * 100} %)`,
  );

  const etcd = r.etcd;
  const membersBad =
    Array.isArray(etcd?.members) &&
    (etcd.members.length === 0 || etcd.members.some((m) => m.healthy !== true));
  add(
    'etcd',
    etcd?.readyz === true && !membersBad,
    !etcd || typeof etcd.readyz !== 'boolean'
      ? 'etcd readiness could not be read'
      : `/readyz/etcd ${etcd.readyz ? 'ok' : 'failing'}; members ${Array.isArray(etcd.members) ? (membersBad ? 'unhealthy' : 'healthy') : 'not read (readiness only)'}`,
  );

  const samples = Array.isArray(etcd?.fsyncP99Ms) ? etcd.fsyncP99Ms : null;
  if (!samples || samples.length < limits.minEtcdSamples || !samples.every(num)) {
    add(
      'etcd-fsync',
      false,
      `need ${limits.minEtcdSamples} etcd latency samples over the window; got ${samples ? samples.length : 'none'}`,
    );
  } else {
    const worst = Math.max(...samples);
    add(
      'etcd-fsync',
      worst < etcdWarnMs,
      `etcd p99 over ${samples.length} samples: worst ${worst.toFixed(2)} ms (need below ${etcdWarnMs} ms)`,
    );
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * remaining: what `kubectl get all,pvc,secret,configmap -l dev.bitop.dev/env=<name>` still lists
 * (null if it could not be listed). For medium and large the pool must be back at its starting
 * allocation.
 */
export function decideTeardown({ profile, remaining, poolBeforeBytes, poolAfterBytes }) {
  const problems = [];
  if (!Array.isArray(remaining)) problems.push('what remains could not be listed');
  else if (remaining.length > 0) problems.push(`objects remain: ${remaining.join(', ')}`);
  if (profile === 'medium' || profile === 'large') {
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!num(poolBeforeBytes) || !num(poolAfterBytes))
      problems.push('the pool allocation before or after could not be read');
    else if (poolAfterBytes > poolBeforeBytes) {
      problems.push(
        `the pool allocation is ${poolAfterBytes} bytes, above its starting value ${poolBeforeBytes}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
