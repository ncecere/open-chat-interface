// The `environment` block of a cluster report: what the numbers were measured on, with the labels
// of docs/dev/scale-harness.md ("Large on the cluster"). cluster.sh describes the nodes when a run
// starts (describeCluster); the render step completes it from what the server itself says
// (completeEnvironment). Nothing is guessed: what was not recorded is said so.

const GIB = 1024 ** 3;

/** In the order of the spec's table; the report prints one row for each. */
export const ENVIRONMENT_LABELS = {
  hardware: 'Hardware',
  sharing: 'Sharing',
  postgres: 'PostgreSQL',
  topology: 'Topology',
  storage: 'Storage',
  loadGenerator: 'Load generator',
  backgroundState: 'Background state',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeCluster({ nodes, dbNode, loadNode, pgSize, apiReplicas, k6Image, commit }) {
  const find = (name) => {
    const found = nodes.find((n) => n.name === name);
    if (!found)
      throw new Error(`Node ${name} is not in the node list; cannot describe the hardware`);
    return found;
  };
  const hardware = [
    [dbNode, 'database'],
    [loadNode, 'load'],
  ]
    .map(([name, role]) => {
      const n = find(name);
      return `${name} (${role}): ${n.cpuCores ?? '?'} CPUs, ${n.memoryBytes ? Math.round(n.memoryBytes / GIB) : '?'} GiB memory, ${n.os ?? 'unknown OS'}, kernel ${n.kernel ?? '?'}, ${n.arch ?? '?'}`;
    })
    .join('; ');
  return {
    kind: 'cluster',
    commit,
    dbNode,
    loadNode,
    hardware,
    sharing: 'Production services and other development environments run on the same nodes.',
    topology: `Database on ${dbNode} (pinned, one instance); ${plural(apiReplicas, 'API replica')} (role web), 1 worker, web proxy, stub model and k6 on ${loadNode}.`,
    storage: `Miroir ext4 loop file on the local-dev class (NVMe), ${pgSize} claim.`,
    loadGenerator: `k6 pod (${k6Image}) on ${loadNode}, limited to 2 CPUs and 2 GiB.`,
  };
}

const ORDER = ['finished', 'running', 'pending', 'paused', 'failed'];

/** "2 finished, 1 running (name)" from tab-separated `name status rows estimate` lines. */
export function summariseBackground(tsv) {
  if (typeof tsv !== 'string') return 'not recorded';
  const byStatus = {};
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [name, status] = line.split('\t');
    byStatus[status] = [...(byStatus[status] ?? []), name];
  }
  const statuses = [
    ...ORDER.filter((s) => s in byStatus),
    ...Object.keys(byStatus).filter((s) => !ORDER.includes(s)),
  ];
  if (statuses.length === 0) return 'none listed';
  return statuses
    .map(
      (status) =>
        `${byStatus[status].length} ${status}${status === 'finished' ? '' : ` (${byStatus[status].join(', ')})`}`,
    )
    .join(', ');
}

const KEY_SETTINGS = [
  'max_connections',
  'shared_buffers',
  'effective_cache_size',
  'work_mem',
  'maintenance_work_mem',
  'max_wal_size',
  'checkpoint_timeout',
  'wal_compression',
  'random_page_cost',
  'track_io_timing',
  'max_parallel_maintenance_workers',
];

function settingsSummary(tsv) {
  const settings = new Map();
  for (const line of String(tsv ?? '').split('\n')) {
    const [name, setting, unit] = line.split('\t');
    if (name && setting !== undefined) settings.set(name, unit ? `${setting} ${unit}` : setting);
  }
  const shown = KEY_SETTINGS.filter((name) => settings.has(name)).map(
    (name) => `${name} ${settings.get(name)}`,
  );
  return shown.length > 0 ? shown.join(', ') : null;
}

/** The base from describeCluster plus the server's version, settings and background migrations. */
export function completeEnvironment(
  base,
  { pgVersion, extensions, settings, backgroundBefore, backgroundAfter },
) {
  const version = /PostgreSQL (\d+(?:\.\d+)*)/.exec(pgVersion ?? '')?.[1] ?? null;
  const vector = /^vector (\S+)/m.exec(extensions ?? '')?.[1] ?? null;
  const shown = settingsSummary(settings);
  const postgres =
    version === null
      ? "PostgreSQL version not recorded (a dev-env database is PostgreSQL 18 with pgvector, not production's PostgreSQL 17)."
      : `PostgreSQL ${version}${vector ? ` with pgvector ${vector}` : ''}, not production's PostgreSQL 17: planner and I/O changes in 18 can move a result either way.${shown ? ` Settings from pg_settings: ${shown}.` : ''}`;
  return {
    ...base,
    pgVersion: version,
    pgvector: vector,
    postgres,
    backgroundState: `At the start of the load: ${summariseBackground(backgroundBefore)}. At the end: ${summariseBackground(backgroundAfter)}.`,
  };
}
