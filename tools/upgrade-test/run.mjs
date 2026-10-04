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
 *    then each API replica restarted on TO (a rolling restart of the new
 *    release, which is where draining on shutdown is measured), then the
 *    smoke suite against TO.
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
import { seedConversations, seededThreadsFor, setupThroughApi, WORDS } from './seed.mjs';
import { runSmoke } from './smoke.mjs';

const REGISTRY = 'ghcr.io/ncecere/open-chat-interface';
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The first release whose API drains on shutdown (design item 13). */
const FIRST_DRAINING = 'v0.11.0';
/** The migrator's advisory lock key (packages/db/src/migrator.ts), split as pg_locks shows it. */
const MIGRATION_LOCK = 8374920115573001n;

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

async function ensureImage(image) {
  if (!options.pull && (await run('docker', ['image', 'inspect', image])).code === 0) return;
  log(`pulling ${image}`);
  let result = await run('docker', ['pull', '-q', image]);
  // Releases are published for linux/amd64 only; elsewhere, run them emulated.
  if (result.code !== 0)
    result = await run('docker', ['pull', '-q', '--platform', 'linux/amd64', image]);
  if (result.code !== 0) throw new Error(`docker pull ${image} failed: ${result.stderr}`);
}

async function buildFromSource(app, version) {
  const image = `oci-upgrade-${app}:to`;
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from source (${version}, ${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run('docker', [
      'build',
      '-q',
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
  const high = Number(MIGRATION_LOCK >> 32n);
  const low = Number(MIGRATION_LOCK & 0xffffffffn);
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
                        and l.classid = ${high} and l.objid = ${low} and l.granted);`;
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
  await ensureImage(R.from.api);
  await ensureImage(R.from.web);

  const toApi = options['to-api'] || (await buildFromSource('api', sourceVersion));
  const toWeb = options['to-web'] || (await buildFromSource('web', sourceVersion));
  if (options['to-api']) await ensureImage(toApi);
  if (options['to-web']) await ensureImage(toWeb);
  R.to = { version: sourceVersion, api: toApi, web: toWeb };
  let toApiEffective = toApi;
  if (options.inject) {
    const injected = await buildInjectedImage(options.inject, toApi, outDir, log);
    R.inject = { case: options.inject, ...injected };
    toApiEffective = injected.image;
  }
  const toJournal = await readJournal(toApiEffective);

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
  const loadPeople = people.slice(0, Math.min(options.vus, people.length - 1));
  const smokePerson = people.at(-1);
  const threadMap = await seededThreadsFor(loadPeople, env);
  const before = await appliedMigrationTimes();

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
    for (const [service, variable, image, kind, drains] of targets) {
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
    R.postDeploy =
      'not run: post-deploy steps and background migrations (design section 1) are not built yet';

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
