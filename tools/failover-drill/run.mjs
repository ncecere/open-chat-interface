#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone test tool, never a Turbo task.
/**
 * Failover drill (v0.11 design, section 3; docs/dev/failover.md).
 *
 * 1. A three-node Patroni cluster (Spilo, etcd, HAProxy) with OCI built from
 *    this checkout in front of it: two API replicas (OCI_ROLE=web) and one
 *    worker (OCI_ROLE=worker) behind the bundled web proxy.
 * 2. A light steady load (load.mjs) and, as the job in progress, a large
 *    conversation import that the worker processes in batches.
 * 3. Mid-load, mid-job and with replies streaming, `patronictl failover` moves
 *    the primary to a replica. HAProxy closes every connection to the old one.
 * 4. Checks: no request failed except with the retryable class (500 with
 *    `X-OCI-Retryable`) within --window-seconds of the failover; every reply
 *    in flight finished or was saved as interrupted (never left streaming or
 *    failed); the import finished with every conversation; background jobs
 *    ran again after the failover and none was left running.
 *
 * `--redis` (v0.11 design, item 16): Redis runs under Sentinel (a primary,
 * a replica, three sentinels) and the drill kills the Redis primary
 * (SIGKILL) instead of moving the PostgreSQL one, mid-load with replies
 * streaming and every third reply read only partly, then resumed. Checks: no
 * request failed at all; every reply finished or was resumed to its end and
 * is stored complete; replies started after the API followed the new
 * primary are resumable again; no OCI process exited.
 *
 * Exit codes: 0 pass, 1 a check failed, 2 the drill itself could not run.
 */
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN,
  latencyStats,
  MODEL_SLUG,
  PERSON_PASSWORD,
  parseArgs,
  run,
  sleep,
} from '../upgrade-test/lib.mjs';
import { setupThroughApi, WORDS } from '../upgrade-test/seed.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');
const PROJECT = 'oci-failover';
const COMPOSE_FILE = join(TOOL_DIR, 'compose.yaml');
const PATRONI_CONFIG = '/home/postgres/postgres.yml';
const SUPERUSER_URL = 'postgresql://postgres:failover-drill-superuser@haproxy:5432';
/** Stored on a reply saved as interrupted (apps/api/src/services/chat/run-recovery.ts). */
const INTERRUPTED = 'This reply was interrupted';
/** Recorded on a job run cut short by a lost lock (apps/api/src/services/jobs/runner.ts). */
const LOST_LOCK = 'Stopped early: the job lost its lock';

const spec = {
  'api-image': { default: '' },
  'web-image': { default: '' },
  out: {
    default: resolve(TOOL_DIR, 'out', new Date().toISOString().replace(/[:.]/g, '-')),
  },
  port: { type: 'number', default: 18580 },
  people: { type: 'number', default: 8 },
  vus: { type: 'number', default: 6 },
  'think-ms': { type: 'number', default: 300 },
  'send-every': { type: 'number', default: 1 },
  'baseline-seconds': { type: 'number', default: 20 },
  'after-seconds': { type: 'number', default: 40 },
  /** Retryable failures are accepted from the failover until this long after HAProxy switched. */
  'window-seconds': { type: 'number', default: 30 },
  'import-conversations': { type: 'number', default: 5000 },
  /** How many times to move the primary, a minute apart (the first mid-job). */
  failovers: { type: 'number', default: 1 },
  'settle-seconds': { type: 'number', default: 240 },
  /** Kill the Redis primary (under Sentinel) instead of moving the PostgreSQL one. */
  redis: { type: 'boolean', default: false },
  /** With --redis: every Nth reply is read for --cut-after-ms only, then resumed. */
  'cut-every': { type: 'number', default: 3 },
  'cut-after-ms': { type: 'number', default: 1200 },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

const options = parseArgs(process.argv.slice(2), spec);
if (options.help) {
  console.log(
    `Usage: node tools/failover-drill/run.mjs [options]\n\n${Object.entries(spec)
      .map(([k, v]) => `  --${k}${v.type === 'boolean' ? '' : ' <value>'}  (default: ${v.default})`)
      .join('\n')}`,
  );
  process.exit(0);
}

const outDir = resolve(options.out);
mkdirSync(outDir, { recursive: true });
const base = `http://127.0.0.1:${options.port}`;
const env = { OCI_DRILL_PORT: String(options.port) };
const SENTINELS = ['sentinel-1', 'sentinel-2', 'sentinel-3'];
if (options.redis)
  Object.assign(env, {
    OCI_DRILL_REDIS_URL: '',
    OCI_DRILL_REDIS_SENTINELS: SENTINELS.map((name) => `${name}:26379`).join(','),
  });
const timeline = [];
const startedAt = Date.now();
function log(what) {
  const at = new Date().toISOString();
  timeline.push({ at, what });
  console.log(`[failover-drill ${at.slice(11, 19)}] ${what}`);
}

/* ------------------------------------------------------------------------ */

function compose(args, options = {}) {
  const profiles = options.redis === false ? [] : ['--profile', 'redis-ha'];
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...profiles, ...args], {
    env: { ...env, ...options.env },
    ...options,
  });
}

async function must(promise, what) {
  const result = await promise;
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result;
}

/** SQL through HAProxy, so it always reaches the current primary. */
async function psql(sql, { database = 'oci', node = 'pg-1' } = {}) {
  const result = await must(
    compose(
      [
        'exec',
        '-T',
        node,
        'psql',
        `${SUPERUSER_URL}/${database}`,
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-F',
        '\t',
      ],
      { input: sql },
    ),
    'psql',
  );
  return result.stdout.trim();
}

async function cluster() {
  for (const node of ['pg-1', 'pg-2', 'pg-3']) {
    const result = await compose([
      'exec',
      '-T',
      node,
      'patronictl',
      '-c',
      PATRONI_CONFIG,
      'list',
      '-f',
      'json',
    ]);
    if (result.code === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch {}
    }
  }
  return [];
}

async function waitFor(what, check, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

async function buildImage(app) {
  const image = `oci-failover-${app}:drill`;
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from this checkout (${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run(
      'docker',
      [
        'build',
        '-q',
        '-f',
        `docker/${app}.Dockerfile`,
        '--build-arg',
        `OCI_REVISION=${revision}`,
        '-t',
        image,
        '.',
      ],
      {
        cwd: REPO_ROOT,
      },
    ),
    `building ${image}`,
  );
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return image;
}

let sessions = 0;
/**
 * A signed-in person for setup and checks (the load has its own client), from
 * an address of its own: Better Auth allows three sign-ins per address in 10 s.
 */
async function session(email, password = PERSON_PASSWORD) {
  const ip = `198.19.1.${++sessions}`;
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(`Sign-in for ${email} failed: HTTP ${response.status}`);
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ');
  return async (method, path, body) => {
    const headers = { cookie, origin: base, 'x-forwarded-for': ip };
    if (body !== undefined && !(body instanceof FormData))
      headers['content-type'] = 'application/json';
    const reply = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await reply.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: reply.status, json, text };
  };
}

/** The host name the sentinels give for the Redis primary (the Compose service name). */
async function sentinelPrimary() {
  for (const sentinel of SENTINELS) {
    const result = await compose([
      'exec',
      '-T',
      sentinel,
      'redis-cli',
      '-p',
      '26379',
      'SENTINEL',
      'get-master-addr-by-name',
      'oci',
    ]);
    const host = result.stdout.trim().split('\n')[0];
    if (result.code === 0 && host) return host;
  }
  return null;
}

/** Whether `service` is a Redis replica in sync with its primary. */
async function redisReplicaInSync(service) {
  const result = await compose(['exec', '-T', service, 'redis-cli', 'INFO', 'replication']);
  return result.stdout.includes('role:slave') && result.stdout.includes('master_link_status:up');
}

/** The Redis row of System health, as one API replica sees it. */
async function redisHealth(admin) {
  const health = await admin('GET', '/api/admin/health');
  return health.json?.checks?.find((check) => check.id === 'redis') ?? null;
}

/**
 * Kills the Redis primary (SIGKILL), waits for the sentinels to promote the
 * replica and for the API to use Redis again, then starts the killed node,
 * which the sentinels turn into a replica of the new primary (for the next
 * failover).
 */
async function redisFailover(index, admin) {
  const primary = await sentinelPrimary();
  if (!primary) throw new Error('The sentinels name no Redis primary');
  log(`Redis failover ${index + 1}: killing the primary ${primary}`);
  const t0 = Date.now();
  await must(compose(['kill', '-s', 'SIGKILL', primary]), 'killing the Redis primary');
  let promotedTo = null;
  const promoted = await waitFor(
    'the sentinels to promote the replica',
    async () => {
      const now = await sentinelPrimary();
      if (!now || now === primary) return null;
      promotedTo = now;
      return Date.now();
    },
    60_000,
    100,
  );
  // Both web replicas: System health is answered by whichever the proxy picks.
  let healthy = 0;
  const followed = await waitFor(
    'the API to use Redis again',
    async () => {
      healthy = (await redisHealth(admin))?.status === 'ok' ? healthy + 1 : 0;
      return healthy >= 4 ? Date.now() : null;
    },
    60_000,
    100,
  );
  await must(compose(['start', primary]), 'starting the old Redis primary again');
  await waitFor(
    'the old primary to rejoin as a replica',
    () => redisReplicaInSync(primary),
    60_000,
    500,
  );
  log(
    `Redis failover ${index + 1}: ${promotedTo} promoted after ${promoted - t0} ms; the API used Redis again after ${followed - t0} ms; ${primary} rejoined as a replica`,
  );
  return {
    from: primary,
    to: promotedTo,
    startedAt: t0,
    commandMs: promoted - t0,
    routedMs: followed - t0,
  };
}

/** A Claude export (a bare JSON array) of `count` short conversations. */
function claudeExport(count) {
  const conversations = [];
  for (let n = 0; n < count; n++) {
    const at = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
    conversations.push({
      uuid: `drill-${n}`,
      name: `Imported during the failover drill ${n}`,
      created_at: at,
      updated_at: at,
      chat_messages: [
        {
          uuid: `drill-${n}-q`,
          sender: 'human',
          text: `Question ${n} about ${WORDS[n % WORDS.length]}`,
          created_at: at,
        },
        { uuid: `drill-${n}-a`, sender: 'assistant', text: `Answer ${n}.`, created_at: at },
      ],
    });
  }
  return JSON.stringify(conversations);
}

/* ------------------------------------------------------------------------ */

const R = { options, startedAt: new Date(startedAt).toISOString(), failovers: [], checks: [] };

async function main() {
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (docker.code !== 0) throw new Error('Docker is not available');

  const apiImage = options['api-image'] || (await buildImage('api'));
  const webImage = options['web-image'] || (await buildImage('web'));
  Object.assign(env, { OCI_DRILL_API_IMAGE: apiImage, OCI_DRILL_WEB_IMAGE: webImage });
  R.images = { api: apiImage, web: webImage };

  // --- The cluster ---------------------------------------------------------
  log('removing any previous oci-failover stack');
  await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5']);
  log('starting etcd and three Patroni nodes');
  await must(
    compose(['up', '-d', '--wait', '--wait-timeout', '300', 'etcd', 'pg-1', 'pg-2', 'pg-3']),
    'starting the cluster',
  );
  const members = await waitFor(
    'a leader and two streaming replicas',
    async () => {
      const list = await cluster();
      const leader = list.find((m) => m.Role === 'Leader' && m.State === 'running');
      const streaming = list.filter((m) => m.Role !== 'Leader' && m.State === 'streaming');
      return leader && streaming.length === 2 ? list : null;
    },
    180_000,
  );
  log(`cluster ready: ${members.map((m) => `${m.Member} ${m.Role}`).join(', ')}`);
  await must(
    compose(['up', '-d', 'haproxy', 'redis', 'stub']),
    'starting haproxy, redis and the stub',
  );
  if (options.redis) {
    log('starting Redis under Sentinel: a primary, a replica and three sentinels');
    await must(
      compose([
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '120',
        'redis-primary',
        'redis-replica',
        ...SENTINELS,
      ]),
      'starting Redis under Sentinel',
    );
    await waitFor('the replica to sync', () => redisReplicaInSync('redis-replica'), 60_000, 500);
    await waitFor(
      'every sentinel to know the replica and the other sentinels',
      async () => {
        for (const sentinel of SENTINELS) {
          const info = await compose([
            'exec',
            '-T',
            sentinel,
            'redis-cli',
            '-p',
            '26379',
            'INFO',
            'sentinel',
          ]);
          if (!/master0:name=oci,status=ok,address=[^,]+,slaves=1,sentinels=3/.test(info.stdout))
            return false;
        }
        return true;
      },
      60_000,
      500,
    );
  }
  await waitFor(
    'HAProxy to reach the primary',
    async () => (await psql('select not pg_is_in_recovery()', { database: 'postgres' })) === 't',
    60_000,
  );
  // While a new cluster settles, HAProxy can still send a connection to a
  // node that is not (or no longer) the primary: retry until the role and
  // database exist. Both steps are idempotent.
  await waitFor(
    'the application role and database',
    async () => {
      await psql(
        `do $$ begin
           if not exists (select from pg_roles where rolname = 'oci') then
             create role oci login password 'failover-drill-only';
           end if;
         end $$;`,
        { database: 'postgres' },
      );
      const exists = await psql("select 1 from pg_database where datname = 'oci'", {
        database: 'postgres',
      });
      if (exists !== '1') await psql('create database oci owner oci;', { database: 'postgres' });
      return true;
    },
    60_000,
  );

  // --- OCI -----------------------------------------------------------------
  log('migrating, then starting two web replicas, a worker and the web proxy');
  await must(compose(['--profile', 'tools', 'run', '--rm', 'migrate']), 'migrate job');
  await must(
    compose(['up', '-d', '--wait', '--wait-timeout', '240', 'api-1', 'api-2', 'worker']),
    'starting OCI',
  );
  await must(compose(['up', '-d', 'web']), 'starting the web proxy');
  await waitFor('the web proxy', async () => (await fetch(`${base}/api/health/ready`)).ok, 120_000);

  const people = await setupThroughApi({
    bases: [base],
    origin: base,
    people: options.people + 1,
    stubUrl: 'http://stub:4181/v1',
    log,
  });
  await psql(`update "user" set email_verified = true where email like 'person%@upgrade.test';`);
  const importer = people.at(-1);
  const loadPeople = [];
  for (const email of people.slice(0, -1)) {
    const as = await session(email);
    const threads = [];
    for (let n = 0; n < 3; n++) {
      const created = await as('POST', '/api/threads', { title: `Drill seed ${n}` });
      if (created.status !== 201) throw new Error(`Creating a thread failed: ${created.status}`);
      threads.push(created.json.thread.id);
    }
    loadPeople.push({ email, threads });
  }
  log(`${loadPeople.length} people with 3 conversations each, and ${importer} for the import`);

  // --- Load ----------------------------------------------------------------
  const eventsFile = join(outDir, 'events.ndjson');
  writeFileSync(eventsFile, '');
  const configFile = join(outDir, 'load-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      eventsFile,
      base,
      origin: base,
      vus: options.vus,
      thinkMs: options['think-ms'],
      sendEvery: options['send-every'],
      requestTimeoutMs: 30_000,
      replyTimeoutMs: 120_000,
      cutEvery: options.redis ? options['cut-every'] : 0,
      cutAfterMs: options['cut-after-ms'],
      password: PERSON_PASSWORD,
      modelSlug: MODEL_SLUG,
      words: WORDS,
      people: loadPeople,
    }),
  );
  const loadStartedAt = Date.now();
  const load = fork(join(TOOL_DIR, 'load.mjs'), [configFile], { stdio: 'inherit' });
  const loadDone = new Promise((resolveDone) => {
    load.on('message', (m) => m?.type === 'done' && resolveDone(m.counters));
    load.on('exit', () => resolveDone(null));
  });
  log(`load running (${options.vus} people); baseline for ${options['baseline-seconds']} s`);
  await sleep(options['baseline-seconds'] * 1000);

  // --- The job in progress --------------------------------------------------
  const importAs = await session(importer);
  const form = new FormData();
  form.append(
    'file',
    new File([claudeExport(options['import-conversations'])], 'conversations.json', {
      type: 'application/json',
    }),
  );
  const queued = await importAs('POST', '/api/me/imports', form);
  if (queued.status !== 202)
    throw new Error(`The import upload failed: ${queued.status} ${queued.text}`);
  const importId = queued.json.import.id;
  const running = await waitFor(
    'the worker to be importing',
    async () => {
      const list = await importAs('GET', '/api/me/imports');
      const row = list.json?.imports?.find((i) => i.id === importId);
      return row?.status === 'running' && row.importedCount >= 50 ? row : null;
    },
    90_000,
    250,
  );
  log(
    `import of ${options['import-conversations']} conversations running on the worker (${running.importedCount} so far)`,
  );

  // --- Failover ------------------------------------------------------------
  const admin = options.redis ? await session(ADMIN.email, ADMIN.password) : null;
  if (admin) {
    const health = await redisHealth(admin);
    if (health?.status !== 'ok')
      throw new Error(`Redis is not healthy before the failover: ${JSON.stringify(health)}`);
    log(`System health before the Redis failover: ${health.detail}`);
  }
  for (let index = 0; index < options.failovers; index++) {
    if (index > 0) await sleep(60_000);
    await waitFor(
      'a reply streaming',
      async () => {
        const active = await compose([
          'exec',
          '-T',
          'stub',
          'wget',
          '-q',
          '-O',
          '-',
          'http://127.0.0.1:4181/active',
        ]);
        return JSON.parse(active.stdout).length > 0;
      },
      30_000,
      200,
    );
    if (options.redis) {
      R.failovers.push(await redisFailover(index, admin));
      continue;
    }
    const before = await cluster();
    const leader = before.find((m) => m.Role === 'Leader');
    const candidate = before.find((m) => m.Role !== 'Leader' && m.State === 'streaming');
    const inFlightImport = (await importAs('GET', '/api/me/imports')).json?.imports?.find(
      (i) => i.id === importId,
    );
    log(`failover ${index + 1}: moving the primary from ${leader.Member} to ${candidate.Member}`);
    const t0 = Date.now();
    const result = await compose([
      'exec',
      '-T',
      candidate.Member,
      'patronictl',
      '-c',
      PATRONI_CONFIG,
      'failover',
      '--candidate',
      candidate.Member,
      '--force',
    ]);
    const t1 = Date.now();
    if (result.code !== 0)
      throw new Error(`patronictl failover failed: ${result.stderr || result.stdout}`);
    const switched = await waitFor(
      'HAProxy to route to the new primary',
      async () => {
        const row = await psql('select host(inet_server_addr()), pg_is_in_recovery()', {
          node: candidate.Member,
        });
        const [address, recovery] = row.split('\t');
        return address === candidate.Host && recovery === 'f' ? Date.now() : null;
      },
      60_000,
      100,
    );
    const failover = {
      from: leader.Member,
      to: candidate.Member,
      startedAt: t0,
      commandMs: t1 - t0,
      routedMs: switched - t0,
      importInFlight: inFlightImport
        ? { status: inFlightImport.status, imported: inFlightImport.importedCount }
        : null,
    };
    R.failovers.push(failover);
    log(
      `failover ${index + 1}: patronictl ${failover.commandMs} ms; HAProxy routing to ${candidate.Member} after ${failover.routedMs} ms`,
    );
  }

  log(`load continues for ${options['after-seconds']} s`);
  await sleep(options['after-seconds'] * 1000);
  load.send({ type: 'stop' });
  const counters = await loadDone;
  const loadEndedAt = Date.now();
  log(`load stopped: ${JSON.stringify(counters)}`);

  // --- Settle and check ----------------------------------------------------
  log('waiting for the import to finish and for interrupted replies to be recovered');
  let lastImport = null;
  const finishedImport = await waitFor(
    'the import to finish',
    async () => {
      const list = await importAs('GET', '/api/me/imports');
      const row = list.json?.imports?.find((i) => i.id === importId);
      if (row) lastImport = row;
      return row && ['completed', 'failed'].includes(row.status) ? row : null;
    },
    options['settle-seconds'] * 1000,
    2000,
  ).catch(() => null);
  const since = new Date(loadStartedAt).toISOString();
  const streamingLeft = await waitFor(
    'no reply left streaming',
    async () => {
      const n = Number(
        await psql(
          `select count(*) from message where role = 'assistant' and status = 'streaming' and created_at >= '${since}'`,
        ),
      );
      return n === 0 ? 'none' : null;
    },
    90_000,
    2000,
  ).catch(() => 'some');

  const events = readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const requests = events.filter((e) => e.type !== 'reply');
  const replies = events.filter((e) => e.type === 'reply');
  const firstFailover = R.failovers[0];
  const windows = R.failovers.map((f) => ({
    from: f.startedAt - 1000,
    to: f.startedAt + f.routedMs + options['window-seconds'] * 1000,
  }));
  const inWindow = (at) => windows.some((w) => at >= w.from && at <= w.to);
  const failures = requests.filter((e) => e.outcome === 'fail');
  const retryable = failures.filter(
    (e) => e.status === 500 && e.retryable === 'database-connection',
  );
  const unexpected = failures.filter((e) => !(retryable.includes(e) && inWindow(e.at)));
  const latencyAround = latencyStats(requests.filter((e) => inWindow(e.at)).map((e) => e.ttfb));
  const latencyBaseline = latencyStats(
    requests.filter((e) => e.at < firstFailover.startedAt - 1000).map((e) => e.ttfb),
  );

  const statusRows = await psql(
    `select status, coalesce(error_message like '${INTERRUPTED}%', false), count(*) from message
     where role = 'assistant' and created_at >= '${since}' group by 1, 2 order by 1, 2`,
  );
  const stored = Object.fromEntries(
    statusRows
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, interrupted, count] = line.split('\t');
        return [
          status === 'cancelled' && interrupted === 't' ? 'interrupted' : status,
          Number(count),
        ];
      }),
  );
  const failoverAt = new Date(firstFailover.startedAt).toISOString();
  const [lostLock, ranAfter, stuck] = (
    await psql(
      `select
         (select count(*) from job_run where error_message like '${LOST_LOCK}%'),
         (select count(*) from job_run where status = 'success' and started_at > '${failoverAt}'::timestamptz + interval '5 seconds'),
         (select count(*) from job_run where finished_at is null and started_at < now() - interval '2 minutes')`,
    )
  )
    .split('\t')
    .map(Number);
  const jobsAfter = await psql(
    `select job_name, count(*) from job_run where status = 'success' and started_at > '${failoverAt}'::timestamptz + interval '5 seconds' group by 1 order by 1`,
  );

  R.load = { counters, startedAt: loadStartedAt, endedAt: loadEndedAt, vus: options.vus };
  R.requests = {
    total: requests.length,
    failed: failures.length,
    retryableInWindow: retryable.filter((e) => inWindow(e.at)).length,
    unexpected: unexpected.length,
    unexpectedSamples: unexpected.slice(0, 10),
    retryableSamples: retryable.slice(0, 10),
    latencyBaseline,
    latencyAroundFailover: latencyAround,
  };
  R.replies = {
    total: replies.length,
    byOutcome: Object.fromEntries(
      [...new Set(replies.map((r) => r.outcome))].map((outcome) => [
        outcome,
        replies.filter((r) => r.outcome === outcome).length,
      ]),
    ),
    stored,
    streamingLeft,
  };
  R.import = finishedImport ?? { notFinished: true, lastSeen: lastImport };
  R.jobs = {
    lostLockRuns: lostLock,
    successfulRunsAfterFailover: ranAfter,
    stuckRuns: stuck,
    byJobAfterFailover: Object.fromEntries(
      jobsAfter
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
        .map(([name, count]) => [name, Number(count)]),
    ),
  };

  const check = (name, pass, detail) => R.checks.push({ name, pass, detail });
  if (options.redis) {
    // A Redis failover may cost resumability for a moment, never a request.
    const cut = replies.filter((r) => r.cut);
    // A resume answered 204 is right for a reply that had already finished
    // (or that started while Redis was away, so was never resumable): the
    // web app then shows the saved reply, checked below to be complete.
    const notResumed = cut.filter(
      (r) => r.outcome !== 'resumed' && r.resumed !== 'nothing-to-resume',
    );
    const nothingToResume = cut.filter((r) => r.resumed === 'nothing-to-resume');
    const lastFollowed = Math.max(...R.failovers.map((f) => f.startedAt + f.routedMs));
    const after = replies.filter((r) => r.startedAt > lastFollowed + 2_000);
    const notResumable = after.filter((r) => r.persistence !== 'redis');
    const exited = [];
    for (const service of ['api-1', 'api-2', 'worker', 'web']) {
      const state = await compose(['ps', '-a', '--format', '{{.State}}', service]);
      if (state.stdout.trim() !== 'running') exited.push(`${service}: ${state.stdout.trim()}`);
    }
    const health = await redisHealth(await session(ADMIN.email, ADMIN.password));
    R.redis = {
      cutReplies: cut.length,
      nothingToResume: nothingToResume.length,
      notResumed: notResumed.slice(0, 10),
      repliesAfter: after.length,
      notResumableAfter: notResumable.length,
      exited,
      health,
    };
    check(
      'requests',
      failures.length === 0,
      `${requests.length} requests, ${failures.length} failed${failures.length ? `: ${JSON.stringify(failures.slice(0, 3))}` : ''}`,
    );
    check(
      'replies',
      streamingLeft === 'none' &&
        Object.keys(stored).every((status) => status === 'complete') &&
        replies.every(
          (r) => ['complete', 'resumed'].includes(r.outcome) || r.resumed === 'nothing-to-resume',
        ),
      `${replies.length} replies: ${JSON.stringify(R.replies.byOutcome)}; stored ${JSON.stringify(stored)}; none left streaming: ${streamingLeft === 'none'}`,
    );
    check(
      'resumes across the failover',
      cut.length > 0 && notResumed.length === 0,
      `${cut.length} replies read partly, then resumed: ${cut.length - nothingToResume.length - notResumed.length} to the end, ${nothingToResume.length} already finished or never resumable (204), ${notResumed.length} cut short`,
    );
    check(
      'resumable again after the failover',
      after.length > 0 && notResumable.length === 0,
      `${after.length} replies started after the API followed the new primary; ${notResumable.length} without live replay`,
    );
    check(
      'no process exited',
      exited.length === 0 && health?.status === 'ok',
      `${exited.length ? exited.join('; ') : 'api-1, api-2, worker and web running'}; System health Redis: ${health?.status} (${health?.detail})`,
    );
  } else {
    check(
      'requests',
      unexpected.length === 0,
      `${requests.length} requests, ${failures.length} failed: ${retryable.length} retryable (500 + X-OCI-Retryable) within ${options['window-seconds']} s of a failover, ${unexpected.length} otherwise`,
    );
    check(
      'replies',
      streamingLeft === 'none' && !stored.error && !stored.streaming,
      `${replies.length} replies; stored ${JSON.stringify(stored)}; none left streaming: ${streamingLeft === 'none'}`,
    );
  }
  const expected = options['import-conversations'];
  check(
    'import (the job in progress)',
    finishedImport?.status === 'completed' &&
      finishedImport.failedCount === 0 &&
      finishedImport.importedCount + finishedImport.skippedCount === expected,
    finishedImport
      ? `${finishedImport.status}: ${finishedImport.importedCount} imported, ${finishedImport.skippedCount} skipped (already stored before the failover), ${finishedImport.failedCount} failed of ${expected}`
      : 'did not finish',
  );
  check(
    'jobs resumed',
    ranAfter > 0 &&
      stuck === 0 &&
      (R.jobs.byJobAfterFailover['chat.recover-interrupted-replies'] ?? 0) > 0,
    `${ranAfter} successful runs after the failover (${Object.keys(R.jobs.byJobAfterFailover).join(', ')}); ${lostLock} cut short by a lost lock; ${stuck} left running`,
  );
}

let exitCode = 0;
try {
  await main();
  exitCode = R.checks.every((c) => c.pass) ? 0 : 1;
} catch (error) {
  log(`the drill could not run: ${error instanceof Error ? error.message : String(error)}`);
  R.error = error instanceof Error ? error.message : String(error);
  exitCode = 2;
} finally {
  R.timeline = timeline;
  R.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(R, null, 2));
  const lines = [
    `# Failover drill${options.redis ? ' (Redis)' : ''}: ${exitCode === 0 ? 'PASS' : exitCode === 1 ? 'FAIL' : 'ERROR'}`,
    '',
    ...R.failovers.map((f, i) =>
      options.redis
        ? `- Redis failover ${i + 1}: ${f.from} killed (SIGKILL); ${f.to} promoted by the sentinels after ${f.commandMs} ms; the API used Redis again after ${f.routedMs} ms`
        : `- Failover ${i + 1}: ${f.from} → ${f.to}; patronictl ${f.commandMs} ms; HAProxy routing to the new primary after ${f.routedMs} ms; import in flight: ${f.importInFlight ? `${f.importInFlight.status}, ${f.importInFlight.imported} imported` : 'n/a'}`,
    ),
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...R.checks.map((c) => `| ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${c.detail} |`),
    '',
    R.requests
      ? `Latency (time to headers): baseline p95 ${R.requests.latencyBaseline.p95} ms, max ${R.requests.latencyBaseline.max} ms; around the failover p95 ${R.requests.latencyAroundFailover.p95} ms, max ${R.requests.latencyAroundFailover.max} ms.`
      : '',
    R.error ? `Error: ${R.error}` : '',
  ];
  writeFileSync(join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}\n\nReport: ${join(outDir, 'report.md')}`);
  if (!options.keep) {
    log('removing the stack');
    await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '10']);
  }
}
process.exit(exitCode);
