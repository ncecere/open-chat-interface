#!/usr/bin/env node
/**
 * Rolling-upgrade test (docs/dev/v0.11-design.md section 5; how to run it and
 * what it proves: docs/dev/rolling-upgrades.md).
 *
 * 1. FROM = a published release (default: the newest stable tag older than the
 *    source's version), TO = images built from this checkout (or --to-api/--to-web).
 * 2. PostgreSQL 17 with pgvector, Redis, a stub model, two FROM API replicas
 *    and two web proxies. FROM migrates; people are created through the API and
 *    conversations seeded through SQL against FROM's schema.
 * 3. A steady load runs through the web proxies for the rest of the test.
 * 4. Under load: TO's pre-deploy migrations (the compose `migrate` job), the
 *    smoke suite against FROM on the new schema, then each API replica and web
 *    proxy replaced with TO one at a time (SIGTERM, start TO, wait healthy),
 *    then the post-deploy phase (`migrate --post`: concurrent index builds,
 *    and scheduling the background migrations), then each API replica
 *    restarted on TO (a rolling restart of the new release, which is where
 *    draining on shutdown is measured, while a background migration runs),
 *    then a wait for the background migrations to finish, then the smoke
 *    suite against TO.
 * 5. Verdict and report (report.json, report.md) in --out.
 *
 * `--inject <case>` adds a deliberately unsafe migration to TO (inject.mjs) as
 * a negative control; `--expect-fail` then inverts the exit code.
 *
 * Exit codes: 0 pass, 1 verdict failed, 2 the test itself could not run.
 */
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildInjectedImage, CASES } from './inject.mjs';
import {
  compose,
  containerId,
  inspect,
  must,
  PERSON_PASSWORD,
  PROJECT,
  parseArgs,
  psql,
  REPO_ROOT,
  run,
  sleep,
  TOOL_DIR,
  waitHealthy,
  waitHttp,
} from './lib.mjs';
import { analyse, writeReports } from './report.mjs';
import {
  seedConversations,
  seededThreadsFor,
  seedUsageEvents,
  setupThroughApi,
  WORDS,
} from './seed.mjs';
import { runSmoke } from './smoke.mjs';

const REGISTRY = 'ghcr.io/ncecere/open-chat-interface';
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The first release whose API drains on shutdown (design item 13). */
const FIRST_DRAINING = 'v0.11.0';
/** The migrators' advisory lock keys (packages/db/src/migrator.ts, post-migrator.ts). */
const MIGRATION_LOCK = 8374920115573001n;
const POST_MIGRATION_LOCK = 8374920115573002n;

const spec = {
  from: { default: '' },
  'to-api': { default: '' },
  'to-web': { default: '' },
  inject: { default: '' },
  out: {
    default: resolve(TOOL_DIR, 'out', new Date().toISOString().replace(/[:.]/g, '-')),
  },
  port: { type: 'number', default: 18480 },
  people: { type: 'number', default: 40 },
  threads: { type: 'number', default: 10_000 },
  'messages-per-thread': { type: 'number', default: 30 },
  /** Usage events seeded (one per seeded reply first, then spread over 60 days). */
  'usage-events': { type: 'number', default: 240_000 },
  vus: { type: 'number', default: 6 },
  'think-ms': { type: 'number', default: 400 },
  'send-every': { type: 'number', default: 2 },
  'baseline-seconds': { type: 'number', default: 20 },
  'settle-seconds': { type: 'number', default: 15 },
  'cooldown-seconds': { type: 'number', default: 10 },
  'stop-timeout': { type: 'number', default: 30 },
  'stub-chunks': { type: 'number', default: 40 },
  'stub-chunk-ms': { type: 'number', default: 100 },
  'p99-ms': { type: 'number', default: 2000 },
  'max-ms': { type: 'number', default: 5000 },
  'lock-wait-ms': { type: 'number', default: 3000 },
  'request-timeout-ms': { type: 'number', default: 30_000 },
  /**
   * Report replies cut off by a stopping replica instead of failing. Off since
   * design item 13 (draining on shutdown). A replica running a release from
   * before it (FROM older than v0.11.0) cannot drain, so the replies it cuts
   * are always reported, and checked for recovery, rather than failed.
   */
  'allow-cut-replies': { type: 'boolean', default: false },
  /**
   * Report failures and latency from SIGTERM of an API replica until
   * --gap-tail-ms after it exited instead of failing. Off since item 13; the
   * windows of replicas on a release from before it are always reported.
   */
  'allow-shutdown-gaps': { type: 'boolean', default: false },
  'gap-tail-ms': { type: 'number', default: 15_000 },
  'replace-web': { type: 'boolean', default: true },
  /** After the upgrade, restart each API replica on TO, as the next upgrade will. */
  'restart-api': { type: 'boolean', default: true },
  /** Run the post-deploy phase (`migrate --post`) once every replica runs TO. */
  'post-deploy': { type: 'boolean', default: true },
  /**
   * Test-only background migrations TO runs (comma-separated; empty for none):
   * the default rewrites every seeded message in place, a batch at a time.
   */
  background: { default: 'oci-test.rewrite-messages-in-place' },
  'background-timeout-seconds': { type: 'number', default: 300 },
  'expect-fail': { type: 'boolean', default: false },
  /** Pull FROM (and --to-*) images even when a local copy exists. */
  pull: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

const options = parseArgs(process.argv.slice(2), spec);
if (options.help) {
  console.log(
    `Usage: node tools/upgrade-test/run.mjs [options]\n\n${Object.entries(spec)
      .map(([k, v]) => `  --${k}${v.type === 'boolean' ? '' : ' <value>'}  (default: ${v.default})`)
      .join('\n')}\n\nInjected cases: ${Object.keys(CASES).join(', ')}`,
  );
  process.exit(0);
}

const outDir = resolve(options.out);
mkdirSync(outDir, { recursive: true });
const startedAt = Date.now();
const timeline = [];
function log(what) {
  const at = new Date().toISOString();
  timeline.push({ at, what });
  console.log(`[upgrade-test ${at.slice(11, 19)}] ${what}`);
}

const portA = options.port;
const portB = options.port + 1;
const bases = [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`];
const origin = bases[0];
const env = {
  OCI_UPGRADE_PORT: String(portA),
  OCI_UPGRADE_PORT2: String(portB),
  OCI_UPGRADE_STOP_GRACE: `${options['stop-timeout']}s`,
  OCI_UPGRADE_STUB_CHUNKS: String(options['stub-chunks']),
  OCI_UPGRADE_STUB_CHUNK_MS: String(options['stub-chunk-ms']),
  OCI_UPGRADE_TEST_BACKGROUND: options.background,
};

/* ------------------------------------------------------------------------ */

function compareVersions(a, b) {
  const x = a.match(STABLE).slice(1).map(Number);
  const y = b.match(STABLE).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function publishedTags(app) {
  const repo = `${REGISTRY.replace('ghcr.io/', '')}/${app}`;
  const token = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`, {
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());
  const response = await fetch(`https://ghcr.io/v2/${repo}/tags/list?n=1000`, {
    headers: { authorization: `Bearer ${token.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GHCR tag list for ${app}: HTTP ${response.status}`);
  return (await response.json()).tags ?? [];
}

async function resolveFrom(sourceVersion) {
  if (options.from) return options.from.startsWith('v') ? options.from : `v${options.from}`;
  let tags;
  try {
    const [api, web] = await Promise.all([publishedTags('api'), publishedTags('web')]);
    tags = api.filter((t) => web.includes(t));
  } catch (error) {
    log(`could not list GHCR tags (${error.message}); falling back to git tags`);
    tags = (await run('git', ['tag', '-l', 'v*'])).stdout.split('\n');
  }
  const older = tags
    .filter((t) => STABLE.test(t) && compareVersions(t, `v${sourceVersion}`) < 0)
    .sort(compareVersions);
  if (!older.length) throw new Error(`No published stable release older than ${sourceVersion}`);
  return older.at(-1);
}

/** The Docker server's architecture (`amd64`, `arm64`): images of it run natively. */
let hostArchPromise;
function hostArch() {
  hostArchPromise ??= run('docker', ['version', '--format', '{{.Server.Arch}}']).then(
    (r) => r.stdout.trim() || 'amd64',
  );
  return hostArchPromise;
}

async function localArch(image) {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Architecture}}', image]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Makes `image` available, natively when the registry has the host's
 * architecture. Releases from v0.11 are multi-arch (linux/amd64 and
 * linux/arm64); earlier ones are linux/amd64 only and run emulated on other
 * hosts. A local copy of another architecture is replaced when a native one
 * can be pulled (an older run may have pulled it emulated). Returns the
 * architecture used.
 */
async function ensureImage(image) {
  const host = await hostArch();
  const local = await localArch(image);
  if (local === host && !options.pull) return { image, arch: local, emulated: false };
  log(`pulling ${image} for linux/${host}`);
  let result = await run('docker', ['pull', '-q', '--platform', `linux/${host}`, image]);
  if (result.code === 0) return { image, arch: host, emulated: false };
  if (local && !options.pull) {
    log(`${image} has no linux/${host} image; using the local linux/${local} one (emulated)`);
    return { image, arch: local, emulated: true };
  }
  if (host !== 'amd64') {
    log(`${image} has no linux/${host} image; pulling linux/amd64 to run emulated`);
    result = await run('docker', ['pull', '-q', '--platform', 'linux/amd64', image]);
    if (result.code === 0) return { image, arch: 'amd64', emulated: true };
  }
  throw new Error(`docker pull ${image} failed: ${result.stderr}`);
}

async function buildFromSource(app, version) {
  // Named after the compose project, so runs with --project never share an image.
  const image = `${PROJECT}-${app}:to`;
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from source (${version}, ${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run('docker', [
      'build',
      '-q',
      // Natively, whatever DOCKER_DEFAULT_PLATFORM says: both Dockerfiles
      // build on amd64 and arm64.
      '--platform',
      `linux/${await hostArch()}`,
      '-f',
      `docker/${app}.Dockerfile`,
      '--build-arg',
      `OCI_VERSION=${version}`,
      '--build-arg',
      `OCI_REVISION=${revision}`,
      '-t',
      image,
      '.',
    ]),
    `building ${image}`,
  );
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return image;
}

async function readJournal(image) {
  const r = await must(
    run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'cat',
      image,
      '/app/packages/db/drizzle/meta/_journal.json',
    ]),
    `reading the migration journal of ${image}`,
  );
  return JSON.parse(r.stdout).entries;
}

/** Post-deploy steps recorded by `migrate --post`. */
async function postSteps() {
  const out = await psql(
    `select name, coalesce(duration_ms, -1), attempts, finished_at is not null
       from oci_post_migration order by name;`,
    env,
  ).catch(() => '');
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, durationMs, attempts, finished] = line.split('\t');
      return {
        name,
        durationMs: Number(durationMs) < 0 ? null : Number(durationMs),
        attempts: Number(attempts),
        finished: finished === 't',
      };
    });
}

/** Background migrations and their progress. */
async function backgroundMigrations() {
  const out = await psql(
    `select name, status, rows_processed, batches, attempts, coalesce(last_error, ''),
            coalesce(throttled_reason, ''),
            coalesce((extract(epoch from started_at) * 1000)::bigint, 0),
            coalesce((extract(epoch from finished_at) * 1000)::bigint, 0)
       from background_migration order by name;`,
    env,
  ).catch(() => '');
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, status, rows, batches, attempts, lastError, throttled, started, finished] =
        line.split('\t');
      return {
        name,
        status,
        rowsProcessed: Number(rows),
        batches: Number(batches),
        attempts: Number(attempts),
        lastError: lastError || null,
        throttledReason: throttled || null,
        startedAt: Number(started) || null,
        finishedAt: Number(finished) || null,
        ms: Number(started) && Number(finished) ? Number(finished) - Number(started) : null,
      };
    });
}

/** The usage-rollup backfill (migration 0040, v0.11); its rollups are checked after it. */
const USAGE_ROLLUP_BACKFILL = '0.11.usage-rollups';

const ROLLUP_AMOUNTS = [
  'events',
  'settled_events',
  'messages',
  'tokens_in',
  'tokens_out',
  'cost_micros',
  'quota_messages',
  'quota_tokens',
  'quota_cost_micros',
];
const MODEL_AMOUNTS = ROLLUP_AMOUNTS.slice(0, 6);

/**
 * Compares the usage rollups with the raw events, in one statement (one
 * snapshot, so the load's writes and the fold job cannot make them disagree
 * mid-check): every (UTC hour, person, model) of `usage_rollup_hour` plus the
 * change log not folded yet, and every (hour, model) of
 * `usage_rollup_model_hour` plus the log, against a `group by` over every
 * event, amount by amount (docs/dev/database.md, "Usage rollups"). A rollup
 * key whose amounts all net to zero is no key. Null when TO has no rollups.
 */
async function usageRollupCheck() {
  const [exists] = (
    await psql(`select to_regclass('usage_rollup_hour') is not null;`, env).catch(() => 'f')
  ).trim();
  if (exists !== 't') return null;
  const eventAmounts = `count(*) as events,
      count(*) filter (where not pending) as settled_events,
      coalesce(sum(message_count) filter (where not pending), 0) as messages,
      coalesce(sum(tokens_in) filter (where not pending), 0) as tokens_in,
      coalesce(sum(tokens_out) filter (where not pending), 0) as tokens_out,
      coalesce(sum(cost_micros) filter (where not pending), 0) as cost_micros,
      sum(message_count) as quota_messages,
      sum(tokens_in::bigint + tokens_out + reserved_tokens) as quota_tokens,
      sum(cost_micros + reserved_cost_micros) as quota_cost_micros`;
  const sums = (names) => names.map((name) => `sum(${name})::bigint as ${name}`).join(', ');
  const nonZero = (names) => `not (${names.map((name) => `sum(${name}) = 0`).join(' and ')})`;
  const differs = (names) =>
    `(${names.map((n) => `e.${n}`).join(', ')}) is distinct from (${names.map((n) => `r.${n}`).join(', ')})`;
  const out = await psql(
    `with e as (
       select date_trunc('hour', occurred_at, 'UTC') as hour, user_id, model_slug, ${eventAmounts}
       from usage_event group by 1, 2, 3
     ), em as (
       select hour, model_slug, ${sums(MODEL_AMOUNTS)} from e group by 1, 2
     ), r as (
       select hour, user_id, model_slug, ${sums(ROLLUP_AMOUNTS)}
       from (select hour, user_id, model_slug, ${ROLLUP_AMOUNTS.join(', ')} from usage_rollup_hour
             union all
             select hour, user_id, model_slug, ${ROLLUP_AMOUNTS.join(', ')} from usage_rollup_change) x
       group by 1, 2, 3 having ${nonZero(ROLLUP_AMOUNTS)}
     ), rm as (
       select hour, model_slug, ${sums(MODEL_AMOUNTS)}
       from (select hour, model_slug, ${MODEL_AMOUNTS.join(', ')} from usage_rollup_model_hour
             union all
             select hour, model_slug, ${MODEL_AMOUNTS.join(', ')} from usage_rollup_change) x
       group by 1, 2 having ${nonZero(MODEL_AMOUNTS)}
     )
     select
       (select count(*) from usage_event),
       (select count(*) from usage_event where in_rollup is not true),
       (select count(*) from usage_event where user_id is null),
       (select count(*) from e),
       (select count(*) from e full join r
          on r.hour = e.hour and r.user_id is not distinct from e.user_id and r.model_slug = e.model_slug
        where ${differs(ROLLUP_AMOUNTS)}),
       (select count(*) from em),
       (select count(*) from em e full join rm r on r.hour = e.hour and r.model_slug = e.model_slug
        where ${differs(MODEL_AMOUNTS)}),
       (select count(*) from usage_rollup_hour),
       (select count(*) from usage_rollup_change),
       (select coalesce(sum(events), 0) from e), (select coalesce(sum(events), 0) from r),
       (select coalesce(sum(cost_micros), 0) from e), (select coalesce(sum(cost_micros), 0) from r),
       (select coalesce(sum(quota_tokens), 0) from e), (select coalesce(sum(quota_tokens), 0) from r);`,
    env,
  );
  const [
    events,
    unmarked,
    deletedAccounts,
    personKeys,
    personDiffering,
    modelKeys,
    modelDiffering,
    rollupRows,
    unfolded,
    eventsTotal,
    rollupEventsTotal,
    costTotal,
    rollupCostTotal,
    quotaTokensTotal,
    rollupQuotaTokensTotal,
  ] = out.trim().split('\t').map(Number);
  return {
    events,
    unmarked,
    deletedAccounts,
    personKeys,
    personDiffering,
    modelKeys,
    modelDiffering,
    rollupRows,
    unfolded,
    totals: {
      events: [eventsTotal, rollupEventsTotal],
      costMicros: [costTotal, rollupCostTotal],
      quotaTokens: [quotaTokensTotal, rollupQuotaTokensTotal],
    },
    exact:
      unmarked === 0 &&
      personDiffering === 0 &&
      modelDiffering === 0 &&
      eventsTotal === rollupEventsTotal &&
      costTotal === rollupCostTotal &&
      quotaTokensTotal === rollupQuotaTokensTotal,
  };
}

async function appliedMigrationTimes() {
  const out = await psql(
    'select created_at from drizzle.__drizzle_migrations order by created_at;',
    env,
  );
  return out.trim().split('\n').filter(Boolean).map(Number);
}

/* ------------------------------------------------------------------------ */
/* Lock monitor                                                               */
/* ------------------------------------------------------------------------ */

function startLockMonitor(currentPhase, intervalMs = 1000) {
  // The migrators' own sessions wait by design (a concurrent index build
  // waits for every older transaction); what matters is who waits on them.
  const keys = [MIGRATION_LOCK, POST_MIGRATION_LOCK]
    .map((key) => `(${Number(key >> 32n)}, ${Number(key & 0xffffffffn)})`)
    .join(', ');
  const query = `
    select a.pid,
           (extract(epoch from clock_timestamp() - a.query_start) * 1000)::bigint,
           left(regexp_replace(a.query, '\\s+', ' ', 'g'), 120),
           coalesce((select left(regexp_replace(b.query, '\\s+', ' ', 'g'), 120)
                       from pg_stat_activity b
                      where b.pid = (pg_blocking_pids(a.pid))[1]), '')
      from pg_stat_activity a
     where a.wait_event_type = 'Lock' and a.backend_type = 'client backend'
       and not exists (select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'advisory'
                        and (l.classid::bigint, l.objid::bigint) in (${keys}) and l.granted);`;
  const waits = new Map();
  let running = true;
  const loop = (async () => {
    while (running) {
      const t0 = Date.now();
      try {
        const out = await psql(query, env);
        for (const line of out.trim().split('\n').filter(Boolean)) {
          const [pid, waited, q, blocker] = line.split('\t');
          const key = `${pid}:${q}`;
          const waitedMs = Number(waited);
          const prior = waits.get(key);
          if (!prior || prior.waitedMs < waitedMs) {
            waits.set(key, {
              waitedMs,
              query: q,
              blocker,
              phase: currentPhase(),
            });
          }
        }
      } catch {}
      await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
    }
  })();
  return async () => {
    running = false;
    await loop;
    const top = [...waits.values()].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, 15);
    return {
      intervalMs,
      samples: waits.size,
      maxWaitMs: top[0]?.waitedMs ?? 0,
      top,
    };
  };
}

/* ------------------------------------------------------------------------ */

async function collectLogs(services) {
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  for (const service of services) {
    const r = await compose(['logs', '--no-color', '--timestamps', service], env);
    writeFileSync(join(logDir, `${service}.log`), r.stdout + r.stderr);
  }
}

async function teardown() {
  if (options.keep) {
    log(`--keep: leaving compose project oci-upgrade running (web on ${bases.join(', ')})`);
    return;
  }
  await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5'], env);
}

async function main() {
  const report = {
    run: { timeline, startedAt: new Date(startedAt).toISOString() },
  };
  const R = report.run;

  if ((await run('docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0) {
    throw new Error('Docker is not available');
  }
  const sourceVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const fromTag = await resolveFrom(sourceVersion);
  R.from = {
    version: fromTag,
    api: `${REGISTRY}/api:${fromTag}`,
    web: `${REGISTRY}/web:${fromTag}`,
  };
  // TO is this source, which drains; a published FROM drains from v0.11.0.
  const fromDrains = STABLE.test(fromTag) && compareVersions(fromTag, FIRST_DRAINING) >= 0;
  R.from.drains = fromDrains;
  log(
    `FROM ${fromTag}${fromDrains ? '' : ' (does not drain on shutdown)'}; source version ${sourceVersion}`,
  );
  // TO is prepared (built from source, or pulled) while FROM's stack starts
  // and is seeded, and awaited before the load begins, so building no longer
  // adds to the run; the API and web images build at the same time.
  const preparingTo = (async () => {
    const [toApi, toWeb] = await Promise.all(
      ['api', 'web'].map(async (app) => {
        const given = options[`to-${app}`];
        if (!given) return buildFromSource(app, sourceVersion);
        await ensureImage(given);
        return given;
      }),
    );
    let effective = toApi;
    let inject;
    if (options.inject) {
      inject = await buildInjectedImage(options.inject, toApi, outDir, log);
      effective = inject.image;
    }
    return { toApi, toWeb, effective, inject, journal: await readJournal(effective) };
  })();
  // Rejections surface where it is awaited; this only keeps Node from
  // reporting one as unhandled while FROM starts.
  preparingTo.catch(() => undefined);

  const host = await hostArch();
  const fromImages = await Promise.all([ensureImage(R.from.api), ensureImage(R.from.web)]);
  R.platform = { host: `linux/${host}`, from: fromImages.map((i) => `linux/${i.arch}`) };
  if (fromImages.some((i) => i.emulated))
    log(`FROM ${fromTag} runs emulated (linux/amd64 on linux/${host}); TO runs natively`);

  R.bounds = {
    stopTimeoutMs: options['stop-timeout'] * 1000,
    p99Ms: options['p99-ms'],
    maxMs: options['max-ms'],
    lockWaitMs: options['lock-wait-ms'],
    allowCutReplies: options['allow-cut-replies'],
    allowShutdownGaps: options['allow-shutdown-gaps'],
    gapTailMs: options['gap-tail-ms'],
  };

  // --- Stack on FROM -----------------------------------------------------
  log('removing any previous oci-upgrade stack');
  await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5'], env);
  Object.assign(env, {
    OCI_MIGRATE_IMAGE: R.from.api,
    OCI_API1_IMAGE: R.from.api,
    OCI_API2_IMAGE: R.from.api,
    OCI_WEB1_IMAGE: R.from.web,
    OCI_WEB2_IMAGE: R.from.web,
  });
  log('starting postgres, redis and the stub model');
  await must(
    compose(['up', '-d', '--wait', 'postgres', 'redis', 'stub'], env),
    'starting infrastructure',
  );
  log(`migrating with ${fromTag}'s migrate job`);
  await must(
    compose(['--profile', 'tools', 'run', '--rm', 'migrate'], env),
    `${fromTag} migrate job`,
  );
  log(`starting two ${fromTag} API replicas (RUN_MIGRATIONS=false) and two web proxies`);
  await must(compose(['up', '-d', '--no-deps', 'api-1', 'api-2'], env), 'starting FROM api');
  await Promise.all([waitHealthy('api-1', env), waitHealthy('api-2', env)]);
  await must(compose(['up', '-d', '--no-deps', 'web-1', 'web-2'], env), 'starting FROM web');
  await Promise.all(bases.map((b) => waitHttp(`${b}/api/health/ready`)));

  // --- Data ----------------------------------------------------------------
  const people = await setupThroughApi({
    bases,
    origin,
    people: options.people,
    stubUrl: 'http://stub:4181/v1',
    log,
  });
  // Instances require email verification by default and the test has no mail
  // server, so the accounts created above are marked verified directly.
  await psql(
    `update "user" set email_verified = true where email like 'person%@upgrade.test';`,
    env,
  );
  log(
    `seeding ${options.threads} conversations x ${options['messages-per-thread']} messages through SQL`,
  );
  R.seed = {
    people: people.length,
    ...(await seedConversations({
      env,
      threads: options.threads,
      perThread: options['messages-per-thread'],
      log: (m) => console.log(m),
    })),
  };
  log(
    `seeded ${R.seed.messages} messages (${R.seed.messageTableSize}) in ${Math.round(R.seed.totalMs / 1000)} s`,
  );
  R.seed.usage = await seedUsageEvents({
    env,
    total: options['usage-events'],
    log: (m) => console.log(m),
  });
  log(
    R.seed.usage.skipped
      ? `no usage events seeded: ${R.seed.usage.skipped}`
      : `seeded ${R.seed.usage.events} usage events (${R.seed.usage.tableSize}; ${R.seed.usage.fromReplies} for seeded replies, ${R.seed.usage.deletedAccounts} of deleted accounts, ${R.seed.usage.models} models, ${R.seed.usage.pending} unsettled) in ${(R.seed.usage.totalMs / 1000).toFixed(1)} s`,
  );
  const loadPeople = people.slice(0, Math.min(options.vus, people.length - 1));
  const smokePerson = people.at(-1);
  const threadMap = await seededThreadsFor(loadPeople, env);
  const before = await appliedMigrationTimes();

  // TO must be ready before the load starts: building it beside the load
  // would distort the latencies measured.
  const waitedForTo = Date.now();
  const prepared = await preparingTo;
  if (Date.now() - waitedForTo > 1_000)
    log(`waited ${Math.round((Date.now() - waitedForTo) / 1000)} s for the TO images`);
  const { toApi, toWeb, journal: toJournal } = prepared;
  const toApiEffective = prepared.effective;
  R.to = { version: sourceVersion, api: toApi, web: toWeb };
  if (prepared.inject) R.inject = { case: options.inject, ...prepared.inject };
  R.platform.to = await Promise.all([toApi, toWeb].map((i) => localArch(i))).then((archs) =>
    archs.map((a) => `linux/${a}`),
  );

  // --- Load ----------------------------------------------------------------
  const eventsFile = join(outDir, 'events.ndjson');
  writeFileSync(eventsFile, '');
  const loadConfig = {
    eventsFile,
    bases,
    origin,
    vus: options.vus,
    thinkMs: options['think-ms'],
    sendEvery: options['send-every'],
    signInEvery: 25,
    requestTimeoutMs: options['request-timeout-ms'],
    replyTimeoutMs: 120_000,
    password: PERSON_PASSWORD,
    words: WORDS,
    people: loadPeople.map((email) => ({
      email,
      threads: threadMap.get(email) ?? [],
    })),
  };
  const configFile = join(outDir, 'load-config.json');
  writeFileSync(configFile, JSON.stringify(loadConfig, null, 2));
  R.load = {
    vus: options.vus,
    bases,
    thinkMs: options['think-ms'],
    sendEvery: options['send-every'],
  };
  const load = fork(join(TOOL_DIR, 'load.mjs'), [configFile], {
    stdio: 'inherit',
  });
  const loadDone = new Promise((resolveDone) => {
    load.on('message', (m) => m?.type === 'done' && resolveDone(m.counters));
    load.on('exit', () => resolveDone(null));
  });
  /**
   * Waits (up to 30 s) until the stub model is streaming a reply to this
   * replica, at least a second in, so stopping it always catches one.
   */
  const waitForReplyOn = async (id) => {
    const ip = await inspect(id, '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const r = await compose(
        ['exec', '-T', 'stub', 'wget', '-q', '-O', '-', 'http://127.0.0.1:4181/active'],
        env,
      );
      try {
        const streams = JSON.parse(r.stdout);
        if (streams.some((s) => s.ip === ip && Date.now() - s.startedAt > 1000)) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  };
  let phase = 'baseline';
  const setPhase = (name) => {
    phase = name;
    load.send({ type: 'phase', name });
    log(`phase: ${name}`);
  };
  const stopMonitor = startLockMonitor(() => phase);
  setPhase('baseline');
  await sleep(options['baseline-seconds'] * 1000);

  try {
    // --- Pre-deploy migrations under load ---------------------------------
    setPhase('migrate');
    Object.assign(env, { OCI_MIGRATE_IMAGE: toApiEffective });
    const m0 = Date.now();
    const migration = await compose(['--profile', 'tools', 'run', '--rm', 'migrate'], env);
    const after = await appliedMigrationTimes().catch(() => before);
    const newTimes = after.filter((t) => !before.includes(t));
    R.migration = {
      exitCode: migration.code,
      ms: Date.now() - m0,
      applied: toJournal.filter((e) => newTimes.includes(e.when)).map((e) => e.tag),
      output: (migration.stdout + migration.stderr).slice(-4000),
    };
    log(
      `migrate job exit ${migration.code} in ${Math.round(R.migration.ms / 100) / 10} s; applied: ${R.migration.applied.join(', ') || 'none'}`,
    );

    // --- FROM on the new schema --------------------------------------------
    setPhase('smoke-old');
    R.smokeOld = await runSmoke({
      bases,
      origin,
      person: smokePerson,
      label: 'old',
    });
    log(
      `smoke (previous release, new schema): ${R.smokeOld.total - R.smokeOld.failed}/${R.smokeOld.total}`,
    );

    // --- Replace replicas one at a time -------------------------------------
    R.replacements = [];
    // [service, image variable, image, phase, whether the stopped replica drains]
    const targets = [
      ['api-1', 'OCI_API1_IMAGE', toApiEffective, 'replace', fromDrains],
      ['api-2', 'OCI_API2_IMAGE', toApiEffective, 'replace', fromDrains],
      ...(options['replace-web']
        ? [
            ['web-1', 'OCI_WEB1_IMAGE', toWeb, 'replace', null],
            ['web-2', 'OCI_WEB2_IMAGE', toWeb, 'replace', null],
          ]
        : []),
      // The new release replacing itself: every proxy and replica now runs TO.
      ...(options['restart-api']
        ? [
            ['api-1', 'OCI_API1_IMAGE', toApiEffective, 'restart', true],
            ['api-2', 'OCI_API2_IMAGE', toApiEffective, 'restart', true],
          ]
        : []),
    ];
    const postDeploy = async () => {
      // --- Post-deploy phase: every replica now runs TO -------------------
      setPhase('post-deploy');
      const p0 = Date.now();
      const post = await compose(['--profile', 'tools', 'run', '--rm', 'migrate-post'], env);
      R.postDeploy = {
        exitCode: post.code,
        ms: Date.now() - p0,
        steps: await postSteps(),
        scheduled: (await backgroundMigrations()).map((m) => m.name),
        output: (post.stdout + post.stderr).slice(-4000),
      };
      log(
        `migrate --post exit ${post.code} in ${(R.postDeploy.ms / 1000).toFixed(1)} s; steps: ${
          R.postDeploy.steps
            .map(
              (step) => `${step.name} ${step.finished ? `${step.durationMs} ms` : 'NOT FINISHED'}`,
            )
            .join(', ') || 'none'
        }; background migrations scheduled: ${R.postDeploy.scheduled.join(', ') || 'none'}`,
      );
    };
    let postDone = !options['post-deploy'];
    for (const [service, variable, image, kind, drains] of targets) {
      if (kind === 'restart' && !postDone) {
        await postDeploy();
        postDone = true;
      }
      setPhase(`${kind}-${service}`);
      const isWeb = service.startsWith('web');
      const webBase = service === 'web-1' ? bases[0] : bases[1];
      if (isWeb) {
        // The web tier is a stateless proxy behind whatever balances it; take
        // this one out of rotation first, as that balancer would.
        load.send({ type: 'drain', base: webBase });
        await sleep(3000);
      }
      const id = await containerId(service, env);
      const caughtReply = isWeb ? null : await waitForReplyOn(id);
      const stopRequestedAt = Date.now();
      const stopTimeout = service.startsWith('api') ? options['stop-timeout'] : 10;
      await must(compose(['stop', '-t', String(stopTimeout), service], env), `stopping ${service}`);
      const stoppedAt = Date.now();
      const exitCode = Number(await inspect(id, '{{.State.ExitCode}}'));
      env[variable] = image;
      await must(
        compose(['up', '-d', '--no-deps', service], env),
        `starting ${service} on ${image}`,
      );
      if (isWeb) await waitHttp(`${webBase}/api/health/ready`);
      else await waitHealthy(service, env);
      const readyAt = Date.now();
      if (isWeb) load.send({ type: 'undrain', base: webBase });
      R.replacements.push({
        service,
        kind,
        drains,
        image,
        stopRequestedAt,
        stoppedAt,
        exitCode,
        readyAt,
        caughtReply,
      });
      log(
        `${kind} ${service}: SIGTERM -> exited (code ${exitCode}) in ${((stoppedAt - stopRequestedAt) / 1000).toFixed(1)} s; new replica ready ${((readyAt - stoppedAt) / 1000).toFixed(1)} s later`,
      );
      // Let the proxy re-resolve `api` and route to the new replica before the next stop.
      await sleep(options['settle-seconds'] * 1000);
    }

    if (!postDone) await postDeploy();

    // --- Background migrations, under load --------------------------------------
    if (options['post-deploy']) {
      setPhase('background');
      const b0 = Date.now();
      const deadline = b0 + options['background-timeout-seconds'] * 1000;
      let migrations = await backgroundMigrations();
      while (
        migrations.some((m) => !['finished', 'failed', 'paused'].includes(m.status)) &&
        Date.now() < deadline
      ) {
        await sleep(2000);
        migrations = await backgroundMigrations();
      }
      R.background = {
        waitedMs: Date.now() - b0,
        timedOut: migrations.some((m) => !['finished', 'failed', 'paused'].includes(m.status)),
        timeoutMs: options['background-timeout-seconds'] * 1000,
        migrations,
      };
      log(
        `background migrations: ${
          migrations
            .map(
              (m) =>
                `${m.name} ${m.status}, ${m.rowsProcessed} rows in ${m.batches} batches${m.ms === null ? '' : ` over ${(m.ms / 1000).toFixed(1)} s`}`,
            )
            .join('; ') || 'none'
        } (waited ${(R.background.waitedMs / 1000).toFixed(1)} s after the restarts)`,
      );

      // The usage-rollup backfill: its batches and duration, then whether the
      // rollups equal the raw events (checked under load, in one snapshot).
      const backfill = migrations.find((m) => m.name === USAGE_ROLLUP_BACKFILL) ?? null;
      const c0 = Date.now();
      const check = await usageRollupCheck();
      if (backfill || check) {
        R.usageRollups = { backfill, check, checkMs: Date.now() - c0 };
        log(
          `usage rollups: backfill ${
            backfill
              ? `${backfill.status}, ${backfill.rowsProcessed} events in ${backfill.batches} batches${backfill.ms === null ? '' : ` over ${(backfill.ms / 1000).toFixed(1)} s`}`
              : 'not scheduled'
          }; ${
            check
              ? `${check.events} events, ${check.personKeys} (hour, person, model) keys, ${check.personDiffering} differing; ${check.modelKeys} (hour, model) keys, ${check.modelDiffering} differing; ${check.unmarked} unmarked, ${check.unfolded} unfolded changes: ${check.exact ? 'EXACT' : 'MISMATCH'}`
              : 'no rollup tables'
          } (checked in ${R.usageRollups.checkMs} ms)`,
        );
      }
    }

    // --- TO --------------------------------------------------------------------
    setPhase('smoke-new');
    R.smokeNew = await runSmoke({
      bases,
      origin,
      person: smokePerson,
      label: 'new',
      requireAll: true,
    });
    log(`smoke (new release): ${R.smokeNew.total - R.smokeNew.failed}/${R.smokeNew.total}`);

    setPhase('cooldown');
    await sleep(options['cooldown-seconds'] * 1000);
  } finally {
    load.send({ type: 'stop' });
    R.loadCounters = await loadDone;
    R.locks = await stopMonitor();
  }

  // --- Report -------------------------------------------------------------------
  await collectLogs(['api-1', 'api-2', 'web-1', 'web-2', 'postgres', 'stub']);
  const lines = readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const replies = lines.filter((l) => l.type === 'reply');
  const events = lines.filter((l) => l.type !== 'reply');
  R.durationMs = Date.now() - startedAt;
  report.verdict = analyse({ events, replies, run: R, bounds: R.bounds });
  writeReports(outDir, report);
  log(`report: ${join(outDir, 'report.md')}`);
  for (const c of report.verdict.criteria) {
    console.log(`  ${c.pass ? 'pass' : c.informational ? 'note' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  console.log(`VERDICT: ${report.verdict.pass ? 'PASS' : 'FAIL'}`);
  return report.verdict.pass;
}

let exitCode = 2;
process.on('SIGINT', async () => {
  log('interrupted; tearing down');
  await teardown();
  process.exit(130);
});
try {
  const pass = await main();
  exitCode = pass === !options['expect-fail'] ? 0 : 1;
  if (options['expect-fail']) {
    console.log(
      pass ? 'Expected a failure (negative control) but the test passed.' : 'Failed as expected.',
    );
  }
} catch (error) {
  console.error(`upgrade-test could not complete: ${error.stack ?? error}`);
  await collectLogs(['api-1', 'api-2', 'web-1', 'web-2', 'postgres']).catch(() => {});
} finally {
  await teardown();
}
process.exit(exitCode);
