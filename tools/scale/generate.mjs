#!/usr/bin/env node
/**
 * Scale-test dataset generator for OCI (docs/dev/scale-harness.md).
 *
 *   node tools/scale/generate.mjs --profile small --database-url postgres://...
 *
 * Fills a database the API has already migrated (and nothing else has used)
 * with a deterministic, realistic dataset sized by a profile in profiles.mjs,
 * using COPY from several worker threads. For speed it drops the secondary
 * indexes of the tables it loads and rebuilds them afterwards, and writes with
 * session_replication_role = replica (foreign-key triggers off), so it needs a
 * superuser on a disposable database; foreign keys are checked afterwards.
 *
 * Writes a JSON report (rows, rows/s, database size) and the fixtures the load
 * test uses (people to sign in as, project conversations, search terms).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import {
  databaseSummary,
  deriveTables,
  fixtures,
  formatRate,
  verify,
} from './lib/generate-finish.mjs';
import {
  dropSecondaryIndexes,
  EMBEDDING_TABLE,
  ensureEmbeddingTable,
  INDEX_BACKUP_TABLE,
  LOADED_TABLES,
  log,
  MODELS,
  passwordHash,
  preflight,
  setUpCatalog,
} from './lib/generate-setup.mjs';
import { buildPlan } from './lib/plan.mjs';
import { hashString } from './lib/prng.mjs';
import { auditTask, conversationsTask, filesTask, peopleTask } from './lib/tasks.mjs';
import { profileNamed } from './profiles.mjs';

export { MODELS } from './lib/generate-setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function loadPostgres() {
  const candidates = [
    process.env.OCI_SCALE_POSTGRES_FROM,
    resolve(here, '../../packages/db/package.json'),
    '/app/packages/db/package.json',
  ].filter(Boolean);
  for (const from of candidates) {
    try {
      return createRequire(from)('postgres');
    } catch {
      // Try the next location.
    }
  }
  throw new Error(
    'Cannot load the `postgres` package. Run `pnpm install`, or use tools/scale/run.sh, which runs this inside the API image.',
  );
}

const postgres = loadPostgres();

function connect(url, options = {}) {
  return postgres(url, {
    prepare: false,
    onnotice: () => {},
    max: options.max ?? 4,
    idle_timeout: 30,
    connection: { application_name: 'oci-scale-generate', ...(options.connection ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

async function workerMain() {
  const data = workerData;
  const sql = connect(data.databaseUrl, {
    max: 6,
    connection: { session_replication_role: 'replica', synchronous_commit: 'off' },
  });
  const ctx = { ...data.context, sql, plan: data.plan };
  parentPort.on('message', async (task) => {
    if (task.type === 'exit') {
      await sql.end({ timeout: 5 });
      process.exit(0);
    }
    const started = performance.now();
    try {
      let rows;
      if (task.kind === 'people') rows = await peopleTask(ctx, task.from, task.to);
      else if (task.kind === 'conversations')
        rows = await conversationsTask(ctx, task.from, task.to);
      else if (task.kind === 'files') rows = await filesTask(ctx, task.from, task.to);
      else if (task.kind === 'audit') rows = await auditTask(ctx, task.from, task.to, task.total);
      else throw new Error(`Unknown task ${task.kind}`);
      parentPort.postMessage({ type: 'done', task, rows, ms: performance.now() - started });
    } catch (error) {
      parentPort.postMessage({ type: 'error', task, message: error?.stack ?? String(error) });
    }
  });
}

// ---------------------------------------------------------------------------
// Main side
// ---------------------------------------------------------------------------

function parseOptions() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'tiny' },
      'database-url': { type: 'string' },
      seed: { type: 'string', default: 'oci-scale' },
      now: { type: 'string' },
      workers: { type: 'string' },
      dimensions: { type: 'string', default: '1536' },
      password: { type: 'string', default: process.env.SCALE_PASSWORD ?? 'scale-harness-password' },
      'stub-url': { type: 'string', default: process.env.SCALE_STUB_URL ?? 'http://stub:4181/v1' },
      out: { type: 'string', default: resolve(here, 'results') },
      reset: { type: 'boolean', default: false },
      'skip-vacuum': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: node tools/scale/generate.mjs [options]

  --profile tiny|small|medium|large   dataset size (default tiny)
  --database-url URL                  migrated, otherwise empty database (or DATABASE_URL)
  --seed TEXT                         dataset seed (default oci-scale)
  --now YYYY-MM-DD                    reference date; data spans the year before it (default today, UTC)
  --workers N                         worker threads (default: CPUs, at most 8)
  --dimensions N                      embedding dimensions (default 1536)
  --password TEXT                     everyone's password (default scale-harness-password)
  --stub-url URL                      base URL of the stub model provider (default http://stub:4181/v1)
  --out DIR                           where generate.json and fixtures.json go
  --reset                             delete previously generated data first
  --skip-vacuum                       skip VACUUM ANALYZE after loading`);
    process.exit(0);
  }
  const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Pass --database-url or set DATABASE_URL');
  const today = new Date();
  const now = values.now
    ? new Date(`${values.now}T00:00:00Z`)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (Number.isNaN(now.getTime())) throw new Error('--now must be a date (YYYY-MM-DD)');
  const dimensions = Number(values.dimensions);
  if (!Number.isInteger(dimensions) || dimensions < 2 || dimensions > 4000) {
    throw new Error('--dimensions must be an integer between 2 and 4000');
  }
  if (values.password.length < 12) throw new Error('--password must be at least 12 characters');
  return {
    profile: profileNamed(values.profile),
    databaseUrl,
    seed: values.seed,
    nowMs: now.getTime(),
    workers: Math.max(1, Number(values.workers ?? Math.min(8, availableParallelism()))),
    dimensions,
    password: values.password,
    stubUrl: values['stub-url'],
    out: values.out,
    reset: values.reset,
    vacuum: !values['skip-vacuum'],
  };
}

async function inParallel(items, concurrency, run) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) await run(queue.shift());
  });
  await Promise.all(runners);
}

async function rebuildIndexes(options, indexes) {
  const sql = connect(options.databaseUrl, { max: 3 });
  // Largest tables first, so the long builds overlap with the short ones.
  const sizes = new Map(
    (
      await sql`select relname, pg_relation_size(oid) as size from pg_class where relname = any(${LOADED_TABLES})`
    ).map((row) => [row.relname, Number(row.size)]),
  );
  const tableOf = (definition) => /ON (?:ONLY )?(?:public\.)?"?([a-z_]+)"?/.exec(definition)?.[1];
  const ordered = [...indexes].sort(
    (a, b) => (sizes.get(tableOf(b.definition)) ?? 0) - (sizes.get(tableOf(a.definition)) ?? 0),
  );
  const timings = [];
  await inParallel(ordered, 3, async (index) => {
    const started = performance.now();
    await sql.begin(async (tx) => {
      await tx.unsafe("set local maintenance_work_mem = '512MB'");
      await tx.unsafe('set local max_parallel_maintenance_workers = 2');
      await tx.unsafe(index.definition);
    });
    timings.push({ name: index.name, seconds: (performance.now() - started) / 1000 });
  });
  await sql.unsafe(`drop table ${INDEX_BACKUP_TABLE}`);
  await sql.end({ timeout: 5 });
  return timings.sort((a, b) => b.seconds - a.seconds);
}

async function main() {
  const options = parseOptions();
  const { dataset } = options.profile;
  const seedHash = hashString(options.seed);
  const started = performance.now();
  const timings = {};
  const phase = async (name, run) => {
    const t0 = performance.now();
    log(`${name}…`);
    const result = await run();
    timings[name] = (performance.now() - t0) / 1000;
    log(`${name} done in ${timings[name].toFixed(1)} s`);
    return result;
  };

  const sql = connect(options.databaseUrl, { max: 2 });
  await phase('preflight', () => preflight(sql, options));
  const [organization] = await sql`select id from organization where slug = 'default'`;
  const organizationId =
    organization?.id ??
    (
      await sql`insert into organization (slug, name) values ('default', 'Open Chat Interface') returning id`
    )[0].id;

  const plan = await phase('plan', () => buildPlan(dataset, seedHash, options.nowMs));
  const catalog = await phase('catalog', async () => {
    await ensureEmbeddingTable(sql, options.dimensions);
    return setUpCatalog(sql, options, organizationId, seedHash);
  });
  const hash = await passwordHash(options.password, seedHash);
  const dropped = await phase('drop secondary indexes', () => dropSecondaryIndexes(sql));
  log(`Dropped ${dropped.length} indexes; they are rebuilt after loading`);

  const adminIndexes = plan.attributes
    .map((a, i) => (a.role === 'admin' ? i : -1))
    .filter((i) => i >= 0);
  const context = {
    seedHash,
    nowMs: options.nowMs,
    organizationId,
    passwordHash: hash,
    models: MODELS,
    dimensions: options.dimensions,
    modelKey: catalog.modelKey,
    embeddingTable: EMBEDDING_TABLE,
    adminIndexes,
    people: dataset.people,
    conversations: dataset.conversations,
  };

  // Work in slices of roughly equal cost; the biggest go first.
  const tasks = [];
  const slice = (kind, total, size, extra = {}) => {
    for (let from = 0; from < total; from += size) {
      tasks.push({ kind, from, to: Math.min(total, from + size), ...extra });
    }
  };
  slice(
    'conversations',
    dataset.conversations,
    Math.max(500, Math.ceil(dataset.conversations / 200)),
  );
  slice('files', dataset.projectFiles, Math.max(200, Math.ceil(dataset.projectFiles / 100)));
  slice('audit', dataset.auditEntries, Math.max(5_000, Math.ceil(dataset.auditEntries / 40)), {
    total: dataset.auditEntries,
  });
  slice('people', dataset.people, Math.max(1_000, Math.ceil(dataset.people / 20)));

  const rows = {};
  const loadSeconds = await phase(
    `load (${options.workers} workers, ${tasks.length} slices)`,
    async () => {
      const t0 = performance.now();
      await new Promise((resolveAll, rejectAll) => {
        const queue = [...tasks];
        let active = 0;
        let done = 0;
        let failed = false;
        let lastReport = 0;
        const workers = [];
        const next = (worker) => {
          const task = queue.shift();
          if (!task) return;
          active++;
          worker.postMessage(task);
        };
        for (let w = 0; w < Math.min(options.workers, tasks.length); w++) {
          const worker = new Worker(fileURLToPath(import.meta.url), {
            workerData: { databaseUrl: options.databaseUrl, context, plan: plan.shared },
          });
          workers.push(worker);
          worker.on('message', (message) => {
            active--;
            if (message.type === 'error') {
              if (!failed) {
                failed = true;
                for (const other of workers) other.terminate();
                rejectAll(new Error(`${message.task.kind} slice failed:\n${message.message}`));
              }
              return;
            }
            done++;
            for (const [table, count] of Object.entries(message.rows)) {
              rows[table] = (rows[table] ?? 0) + count;
            }
            const now = performance.now();
            if (now - lastReport > 5_000 || done === tasks.length) {
              lastReport = now;
              const seconds = (now - t0) / 1000;
              log(
                `  ${done}/${tasks.length} slices, ${(rows.message ?? 0).toLocaleString()} messages, ${formatRate(rows.message ?? 0, seconds).toLocaleString()} messages/s`,
              );
            }
            if (done === tasks.length) {
              for (const other of workers) other.postMessage({ type: 'exit' });
              resolveAll();
            } else next(worker);
          });
          worker.on('error', (error) => {
            if (!failed) {
              failed = true;
              rejectAll(error);
            }
          });
          next(worker);
        }
        if (active === 0 && tasks.length === 0) resolveAll();
      });
      return (performance.now() - t0) / 1000;
    },
  );

  const derived = await phase('derive usage, storage and denials', () =>
    deriveTables(sql, options, catalog, organizationId),
  );
  for (const step of derived) if (step.rows !== null) rows[step.name] = step.rows;
  const indexTimings = await phase('rebuild indexes', () => rebuildIndexes(options, dropped));
  if (options.vacuum) {
    await phase('vacuum analyze', async () => {
      const vacuum = connect(options.databaseUrl, { max: 3 });
      await inParallel([...LOADED_TABLES, EMBEDDING_TABLE], 3, (table) =>
        vacuum.unsafe(`vacuum (analyze) "${table}"`),
      );
      await vacuum.end({ timeout: 5 });
    });
  } else {
    await phase('analyze', () => sql.unsafe('analyze'));
  }
  const problems = await phase('verify', () => verify(sql));
  if (problems.length > 0) {
    throw new Error(`Generated data failed verification:\n  ${problems.join('\n  ')}`);
  }

  const counts = {};
  for (const table of [...LOADED_TABLES, EMBEDDING_TABLE, 'storage_usage', 'quota_denial']) {
    const [{ count }] = await sql.unsafe(`select count(*)::bigint as count from "${table}"`);
    counts[table] = Number(count);
  }
  const [ages] = await sql`
    select extract(epoch from (${new Date(options.nowMs)}::timestamptz - min(occurred_at))) / 86400 as usage_days,
           (select extract(epoch from (${new Date(options.nowMs)}::timestamptz - min(created_at))) / 86400 from audit_log) as audit_days
    from usage_event
  `;
  const database = await databaseSummary(sql);
  await sql.end({ timeout: 5 });

  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalSeconds = (performance.now() - started) / 1000;
  const report = {
    profile: options.profile.name,
    seed: options.seed,
    now: new Date(options.nowMs).toISOString(),
    workers: options.workers,
    dimensions: options.dimensions,
    embeddingModelKey: catalog.modelKey,
    dataset,
    counts,
    loadRows: rows,
    timings,
    loadSeconds,
    totalSeconds,
    rowsPerSecondLoad: formatRate(
      Object.entries(rows)
        .filter(([table]) => !derived.some((step) => step.name === table))
        .reduce((a, [, n]) => a + n, 0),
      loadSeconds,
    ),
    rowsPerSecondOverall: formatRate(totalRows, totalSeconds),
    messagesPerSecondLoad: formatRate(counts.message, loadSeconds),
    derived,
    indexTimings,
    database,
    // Retention windows for the retention phase: about the oldest quarter of the data.
    suggestedRetentionDays: {
      usageEvents: Math.max(1, Math.floor(Number(ages?.usage_days ?? 90) * 0.75)),
      auditLog: Math.max(1, Math.floor(Number(ages?.audit_days ?? 365) * 0.75)),
    },
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(resolve(options.out, 'generate.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    resolve(options.out, 'fixtures.json'),
    `${JSON.stringify(fixtures(options, plan, seedHash, options.password), null, 2)}\n`,
  );
  log(
    `Generated ${totalRows.toLocaleString()} rows in ${totalSeconds.toFixed(1)} s (${report.rowsPerSecondOverall.toLocaleString()} rows/s overall, ${report.messagesPerSecondLoad.toLocaleString()} messages/s while loading); database ${(database.bytes / 1024 ** 3).toFixed(2)} GiB`,
  );
  for (const [table, count] of Object.entries(counts))
    log(`  ${table.padEnd(24)} ${count.toLocaleString()}`);
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else {
  workerMain();
}
