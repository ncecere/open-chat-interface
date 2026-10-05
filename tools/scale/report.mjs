#!/usr/bin/env node
/**
 * Scale-harness measurements and report (docs/dev/scale-harness.md).
 *
 *   node report.mjs collect --phase main --since <ISO> --run-dir /results
 *     Reads the database (sizes, dead tuples, pg_stat_statements, job runs,
 *     indexing and embedding backlog) and every API replica's /metrics, and
 *     writes db-<phase>.json.
 *   node report.mjs snapshot --run-dir /results --name before
 *     Backlog counts only, for throughput deltas.
 *   node report.mjs render --run-dir /results
 *     Combines generate.json, the k6 summaries and the collected files into
 *     report.json and report.md.
 */
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PROFILES, TARGETS } from './profiles.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function loadPostgres() {
  for (const from of [
    process.env.OCI_SCALE_POSTGRES_FROM,
    resolve(here, '../../packages/db/package.json'),
    '/app/packages/db/package.json',
  ].filter(Boolean)) {
    try {
      return createRequire(from)('postgres');
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Cannot load the `postgres` package (run inside the API image, or pnpm install)');
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phase: { type: 'string', default: 'main' },
    since: { type: 'string' },
    name: { type: 'string', default: 'before' },
    'run-dir': { type: 'string', default: '/results' },
    'database-url': { type: 'string' },
  },
});
const command = positionals[0];
const runDir = args['run-dir'];

function readJson(name) {
  const path = resolve(runDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeJson(name, value) {
  writeFileSync(resolve(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function database() {
  const postgres = loadPostgres();
  const url = args['database-url'] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
  return postgres(url, { prepare: false, max: 2, onnotice: () => {} });
}

/**
 * The vector table searches use: the current embedding generation's (v0.11),
 * or `project_file_embedding` before generations or before the API recorded one.
 */
async function currentVectorTable(sql) {
  const [{ found }] = await sql`select to_regclass('embedding_generation') is not null as found`;
  if (found) {
    const [row] = await sql`
      select table_name, model_key from embedding_generation where state = 'current'`;
    if (row) return { table: row.table_name, modelKey: row.model_key };
  }
  return { table: 'project_file_embedding', modelKey: null };
}

async function backlog(sql) {
  const { table } = await currentVectorTable(sql);
  const [{ present }] = await sql`select to_regclass(${table}) is not null as present`;
  const embeddings = present ? sql`(select count(*) from ${sql(table)})::bigint` : sql`0::bigint`;
  const [row] = await sql`
    select
      (select count(*) from project_file_chunk)::bigint as passages,
      ${embeddings} as embeddings,
      (select count(*) from attachment a where a.project_id is not null and a.deleted_at is null
         and not exists (select 1 from project_file_index i where i.attachment_id = a.id))::bigint as unindexed_files,
      (select count(*) from project_file_index)::bigint as indexed_files,
      (select count(*) from usage_event)::bigint as usage_events,
      (select count(*) from audit_log)::bigint as audit_entries,
      (select count(*) from message)::bigint as messages,
      now() as at
  `;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, key === 'at' ? value : Number(value)]),
  );
}

/** Prometheus text exposition, only the series we report. */
function parseMetrics(text) {
  const series = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+eE0-9.]+|NaN)/.exec(line);
    if (!match) continue;
    const labels = {};
    for (const pair of (match[2] ?? '').slice(1, -1).matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1]] = pair[2];
    }
    series.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return series;
}

async function scrapeReplicas() {
  const token = process.env.SCALE_METRICS_TOKEN ?? 'scale-harness-metrics-token';
  let addresses = [];
  try {
    addresses = (await lookup('api', { all: true, family: 4 })).map((a) => a.address);
  } catch {
    return { replicas: 0, jobs: {}, routes: [] };
  }
  const jobs = {};
  const jobEntry = (name) => {
    if (!jobs[name]) jobs[name] = { runs: 0, errors: 0, seconds: 0 };
    return jobs[name];
  };
  const routes = new Map();
  let replies = 0;
  const perReplica = [];
  for (const address of addresses) {
    let text;
    try {
      const res = await fetch(`http://${address}:3000/metrics`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue;
    }
    let requests = 0;
    for (const s of parseMetrics(text)) {
      if (s.name === 'oci_http_requests_total') requests += s.value;
      if (s.name === 'oci_job_runs_total') {
        const job = jobEntry(s.labels.job);
        job.runs += s.value;
        if (s.labels.outcome !== 'success') job.errors += s.value;
      } else if (s.name === 'oci_job_duration_seconds_sum') {
        jobEntry(s.labels.job).seconds += s.value;
      } else if (s.name === 'oci_http_request_duration_seconds_sum') {
        const key = `${s.labels.method} ${s.labels.route}`;
        const route = routes.get(key) ?? { route: key, seconds: 0, count: 0 };
        route.seconds += s.value;
        routes.set(key, route);
      } else if (s.name === 'oci_http_request_duration_seconds_count') {
        const key = `${s.labels.method} ${s.labels.route}`;
        const route = routes.get(key) ?? { route: key, seconds: 0, count: 0 };
        route.count += s.value;
        routes.set(key, route);
      } else if (s.name === 'oci_chat_replies_total') {
        replies += s.value;
      }
    }
    perReplica.push({ address, requests });
  }
  return {
    replicas: addresses.length,
    requestsPerReplica: perReplica.map((r) => r.requests),
    replies,
    jobs,
    routes: [...routes.values()]
      .filter((r) => r.count > 0)
      .map((r) => ({ ...r, meanMs: (r.seconds / r.count) * 1000 }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 15),
  };
}

const NAMED_QUERIES = [
  ['Conversation search (message GIN index, filtered to one person)', 'with hits as materialized'],
  ['Project keyword retrieval (ts_rank_cd over one project)', 'ts_rank_cd'],
  ['Project vector retrieval (pgvector exact scan over one project)', '<=>'],
  [
    'Embedding backlog (passages without an embedding)',
    'left join "project_file_embedding(_g\\d+)?" e',
  ],
  ['Sidebar conversation list', '^select .* from "thread" where .*order by "thread"."pinned" desc'],
  ['Conversation messages', '^select .* from "message" where .*"thread_id" = '],
  // Usage reports read usage_event, or from v0.11 the hourly rollups (with
  // the events of partial hours); budget checks and the fold job are apart.
  [
    'Usage reports (usage_event aggregates or rollups)',
    '^(?!.*sum\\(r\\.quota_messages\\))(?!.*delete from usage_rollup_change).*(from "?usage_event"? |from usage_rollup_)',
  ],
  ['Message counts by time (admin overview)', 'from "message" where .*"created_at" >='],
  [
    'Quota admission (usage in the policy window)',
    '(reserved_tokens"::bigint\\), |sum\\(r\\.quota_messages\\))',
  ],
  ['Usage rollup fold (job)', 'delete from usage_rollup_change'],
  ['Session lookup', 'from "session"'],
];

function executionMs(plan) {
  const value = plan?.[0]?.['QUERY PLAN']?.[0]?.['Execution Time'];
  return typeof value === 'number' ? value : null;
}

function median(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/**
 * Times the API's meaning-based retrieval statement (semantic.ts) on the
 * projects with the most passages, plus an unscoped exact scan over every
 * embedding for comparison: what a search would cost without the project
 * filter, or with an approximate index's job done by brute force.
 */
export async function vectorProbe(sql) {
  const { table } = await currentVectorTable(sql);
  const [{ found }] = await sql`select to_regclass(${table}) is not null as found`;
  if (!found) return null;
  const vectors = sql(table);
  const projects = await sql`
    select a.project_id, a.user_id, count(*)::int as passages, array_agg(distinct a.id) as file_ids,
      min(e.model_key) as model_key
    from ${vectors} e join attachment a on a.id = e.attachment_id
    group by a.project_id, a.user_id order by count(*) desc limit 5
  `;
  const results = [];
  for (const project of projects) {
    const timings = [];
    for (let run = 0; run < 3; run++) {
      // The vector store's statement (apps/api/src/services/vector-store/pgvector.ts, v0.11).
      const plan = await sql`
        explain (analyze, format json)
        with q as materialized (
          select embedding from ${vectors}
          where attachment_id = ${project.file_ids[run % project.file_ids.length]} limit 1
        )
        select e.attachment_id, e.ordinal,
          (e.embedding <=> (select embedding from q))::float8 as distance
        from ${vectors} e
        join attachment a on a.id = e.attachment_id
        where a.user_id = ${project.user_id} and a.project_id = ${project.project_id}
          and a.upload_pending = false and a.deleted_at is null
          and e.attachment_id = any(${project.file_ids})
          and e.model_key = ${project.model_key}
        order by distance, e.attachment_id, e.ordinal
        limit 160
      `;
      timings.push(executionMs(plan));
    }
    results.push({
      passages: project.passages,
      files: project.file_ids.length,
      medianMs: median(timings),
      maxMs: Math.max(...timings.filter((t) => t !== null)),
    });
  }
  const [{ count }] = await sql`select count(*)::bigint as count from ${vectors}`;
  const globalTimings = [];
  for (let run = 0; run < 3; run++) {
    const plan = await sql`
      explain (analyze, format json)
      select attachment_id, ordinal
      from ${vectors}
      order by embedding <=> (select embedding from ${vectors} offset ${run * 7} limit 1)
      limit 10
    `;
    globalTimings.push(executionMs(plan));
  }
  return {
    projects: results,
    global: { embeddings: Number(count), medianMs: median(globalTimings) },
  };
}

async function collect() {
  const sql = database();
  const since = args.since ? new Date(args.since) : new Date(Date.now() - 3_600_000);
  const [{ bytes }] = await sql`select pg_database_size(current_database())::bigint as bytes`;
  const tables = await sql`
    select c.relname as name, c.reltuples::bigint as rows,
      pg_total_relation_size(c.oid)::bigint as total_bytes, pg_relation_size(c.oid)::bigint as table_bytes,
      pg_indexes_size(c.oid)::bigint as index_bytes,
      coalesce(s.n_live_tup, 0)::bigint as live, coalesce(s.n_dead_tup, 0)::bigint as dead
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = current_schema() and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 15
  `;
  const indexes = await sql`
    select c.relname as name, t.relname as table_name, pg_relation_size(c.oid)::bigint as bytes,
      coalesce(s.idx_scan, 0)::bigint as scans
    from pg_class c
    join pg_index i on i.indexrelid = c.oid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_indexes s on s.indexrelid = c.oid
    where n.nspname = current_schema()
    order by pg_relation_size(c.oid) desc limit 15
  `;
  let statements = [];
  try {
    statements = await sql`
      select left(regexp_replace(query, '\\s+', ' ', 'g'), 600) as query, calls::bigint as calls,
        total_exec_time as total_ms, mean_exec_time as mean_ms, max_exec_time as max_ms,
        rows::bigint as rows, shared_blks_hit::bigint as hit, shared_blks_read::bigint as read
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
        and query not ilike '%pg_stat_statements%'
      order by total_exec_time desc limit 20
    `;
  } catch {
    statements = null;
  }
  // The statements behind the questions the harness exists to answer.
  let named = null;
  try {
    named = [];
    for (const [label, pattern] of NAMED_QUERIES) {
      const [row] = await sql`
        select coalesce(sum(calls), 0)::bigint as calls, coalesce(sum(total_exec_time), 0) as total_ms,
          coalesce(max(max_exec_time), 0) as max_ms, count(*)::int as statements
        from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
          and query ~ ${pattern}
      `;
      const calls = Number(row.calls);
      named.push({
        label,
        calls,
        meanMs: calls > 0 ? Number(row.total_ms) / calls : null,
        maxMs: Number(row.max_ms),
        totalMs: Number(row.total_ms),
      });
    }
  } catch {
    named = null;
  }
  const jobs = await sql`
    select job_name as job, count(*)::int as runs, coalesce(sum(items_processed), 0)::bigint as items,
      coalesce(sum(duration_ms), 0)::bigint as total_ms, coalesce(max(duration_ms), 0)::int as max_ms,
      count(*) filter (where status = 'error')::int as errors
    from job_run where started_at >= ${since}
    group by job_name order by sum(duration_ms) desc nulls last
  `;
  const out = {
    phase: args.phase,
    collectedAt: new Date().toISOString(),
    since: since.toISOString(),
    databaseBytes: Number(bytes),
    tables: tables.map((t) => ({
      name: t.name,
      rows: Number(t.rows),
      totalBytes: Number(t.total_bytes),
      tableBytes: Number(t.table_bytes),
      indexBytes: Number(t.index_bytes),
      live: Number(t.live),
      dead: Number(t.dead),
    })),
    indexes: indexes.map((i) => ({
      name: i.name,
      table: i.table_name,
      bytes: Number(i.bytes),
      scans: Number(i.scans),
    })),
    named,
    statements: statements?.map((s) => ({
      query: s.query,
      calls: Number(s.calls),
      totalMs: Number(s.total_ms),
      meanMs: Number(s.mean_ms),
      maxMs: Number(s.max_ms),
      rows: Number(s.rows),
      hitRatio:
        Number(s.hit) + Number(s.read) > 0 ? Number(s.hit) / (Number(s.hit) + Number(s.read)) : 1,
    })),
    jobs: jobs.map((j) => ({
      job: j.job,
      runs: j.runs,
      items: Number(j.items),
      totalMs: Number(j.total_ms),
      maxMs: j.max_ms,
      errors: j.errors,
    })),
    backlog: await backlog(sql),
    vectorProbe: args.phase === 'main' ? await vectorProbe(sql) : null,
    metrics: await scrapeReplicas(),
  };
  await sql.end({ timeout: 5 });
  writeJson(`db-${args.phase}.json`, out);
  console.log(
    `Collected db-${args.phase}.json (${(out.databaseBytes / 1024 ** 3).toFixed(2)} GiB)`,
  );
}

async function snapshot() {
  const sql = database();
  writeJson(`backlog-${args.name}.json`, await backlog(sql));
  await sql.end({ timeout: 5 });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function metric(summary, name) {
  const m = summary?.metrics?.[name];
  if (!m) return null;
  return m.values;
}

const fmtMs = (v) =>
  v === undefined || v === null ? '–' : `${Math.round(v).toLocaleString('en-US')}`;
const fmtInt = (v) => (v === undefined || v === null ? '–' : Math.round(v).toLocaleString('en-US'));
const fmtGiB = (b) => `${(b / 1024 ** 3).toFixed(2)} GiB`;
const fmtMiB = (b) => (b >= 1024 ** 3 ? fmtGiB(b) : `${(b / 1024 ** 2).toFixed(0)} MiB`);
const pct = (v) => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(2)}%`);

const SCENARIO_ROWS = [
  ['Sign-in storm (one sign-in)', 'signin_ms', 'signin'],
  ['Sidebar (parallel requests)', 'sidebar_ms', 'browse'],
  ['Sidebar: conversation list request', 'sidebar_threads_ms', 'browse'],
  ['Open a conversation', 'conversation_open_ms', 'browse'],
  ['Reply start added by OCI (chat)', 'chat_pre_model_ms', 'chat'],
  ['  … history under 20k characters', 'chat_pre_model_ms{prompt:short}', 'chat'],
  ['  … history 20k–150k characters', 'chat_pre_model_ms{prompt:medium}', 'chat'],
  ['  … history over 150k characters', 'chat_pre_model_ms{prompt:long}', 'chat'],
  ['Reply start added by OCI (project chat)', 'project_pre_model_ms', 'project'],
  ['  … large project: passages searched', 'project_pre_model_ms{files:searched}', 'project'],
  ['  … small project: files included whole', 'project_pre_model_ms{files:whole}', 'project'],
  ['Chat: time to first byte', 'chat_ttfb_ms', 'chat'],
  ['Chat: whole reply (stub streams ~5 s)', 'chat_total_ms', 'chat'],
  ['Chat: relay after the last token', 'chat_tail_ms', 'chat'],
  ['Project chat: whole reply', 'project_total_ms', 'project'],
  ['Keyword search (all terms)', 'search_ms', 'search'],
  ['Keyword search: common word', 'search_ms{bucket:common}', 'search'],
  ['Keyword search: medium word', 'search_ms{bucket:medium}', 'search'],
  ['Keyword search: rare word', 'search_ms{bucket:rare}', 'search'],
  ['Keyword search: two words', 'search_ms{bucket:phrase}', 'search'],
  ['Admin pages (all)', 'admin_ms', 'admin'],
];
const ADMIN_PAGES = [
  'overview',
  'usage-overview',
  'usage-spend',
  'usage-limits',
  'usage-storage',
  'users',
  'audit',
  'health',
];

function scenarioRows(main) {
  const rows = [];
  const all = [
    ...SCENARIO_ROWS,
    ...ADMIN_PAGES.map((page) => [`Admin: ${page}`, `admin_ms{page:${page}}`, 'admin']),
  ];
  for (const [label, name, scenario] of all) {
    const v = metric(main, name);
    if (!v || !v.count) continue;
    const target = TARGETS[name] ?? null;
    const errors = metric(main, `errors{scenario:${scenario}}`);
    rows.push({
      label,
      metric: name,
      scenario,
      p50: v.med,
      p95: v['p(95)'],
      p99: v['p(99)'],
      max: v.max,
      count: v.count,
      target,
      met: target === null ? null : v['p(95)'] < target,
      errorRate: errors?.rate ?? null,
    });
  }
  return rows;
}

function jobRows(main, before, after, steadySeconds) {
  const out = [];
  for (const [job, label, unit, key] of [
    ['index', 'projects.index-files', 'files', 'indexed_files'],
    ['embed', 'projects.embed-passages', 'passages', 'embeddings'],
  ]) {
    const timing = metric(main, `job_ms{job:${job}}`);
    const items = metric(main, `job_items{job:${job}}`);
    if (!timing) continue;
    const busySeconds = (timing.avg * timing.count) / 1000;
    out.push({
      job: label,
      unit,
      runs: timing.count,
      items: items?.count ?? 0,
      p50Ms: timing.med,
      p95Ms: timing['p(95)'],
      itemsPerBusySecond: busySeconds > 0 ? (items?.count ?? 0) / busySeconds : null,
      itemsPerMinute: steadySeconds > 0 ? ((items?.count ?? 0) * 60) / steadySeconds : null,
      backlogDelta: before && after ? after[key] - before[key] : null,
    });
  }
  return out;
}

function render() {
  const generate = readJson('generate.json');
  const main = readJson('k6-main.json');
  const retention = readJson('k6-retention.json');
  const dbMain = readJson('db-main.json');
  const dbRetention = readJson('db-retention.json');
  const before = readJson('backlog-before.json');
  const after = dbMain?.backlog ?? null;
  const env = process.env;
  const profileName = generate?.profile ?? env.SCALE_PROFILE ?? 'tiny';
  const profile = PROFILES[profileName];
  const scenarios = scenarioRows(main);
  const jobs = jobRows(main, before, after, profile?.load.steadySeconds ?? 0);
  const retentionJobs = ['usage-events', 'audit-log'].map((job) => ({
    job: `retention.${job}`,
    ms: metric(retention, `retention_job_ms{job:${job}}`)?.max ?? null,
    items: metric(retention, `retention_items{job:${job}}`)?.count ?? null,
  }));
  const during = {
    sidebarP95: metric(retention, 'sidebar_during_retention_ms')?.['p(95)'] ?? null,
    conversationP95: metric(retention, 'conversation_open_during_retention_ms')?.['p(95)'] ?? null,
    errors: metric(retention, 'retention_errors')?.rate ?? null,
  };
  const report = {
    profile: profileName,
    date: env.SCALE_DATE ?? new Date().toISOString().slice(0, 10),
    commit: env.SCALE_COMMIT ?? null,
    hardware: {
      cpu: env.SCALE_HW_CPU ?? null,
      memory: env.SCALE_HW_MEMORY ?? null,
      dockerCpus: env.SCALE_DOCKER_CPUS ?? null,
      dockerMemory: env.SCALE_DOCKER_MEMORY ?? null,
      os: env.SCALE_HW_OS ?? null,
    },
    setup: {
      apiReplicas: Number(env.SCALE_API_REPLICAS ?? 1),
      stub: {
        firstTokenMs: Number(env.STUB_FIRST_TOKEN_MS ?? 500),
        tokensPerSecond: Number(env.STUB_TOKENS_PER_SECOND ?? 50),
        replyTokens: Number(env.STUB_REPLY_TOKENS ?? 250),
      },
      load: profile?.load ?? null,
    },
    dataset: generate
      ? {
          counts: generate.counts,
          seconds: generate.totalSeconds,
          loadSeconds: generate.loadSeconds,
          rowsPerSecondLoad: generate.rowsPerSecondLoad,
          rowsPerSecondOverall: generate.rowsPerSecondOverall,
          messagesPerSecondLoad: generate.messagesPerSecondLoad,
          databaseBytes: generate.database.bytes,
          timings: generate.timings,
          slowestIndexes: generate.indexTimings.slice(0, 5),
          dimensions: generate.dimensions,
        }
      : null,
    targets: TARGETS,
    scenarios,
    jobs,
    retention: { jobs: retentionJobs, during, backlog: dbRetention?.backlog ?? null },
    database: dbMain
      ? {
          bytes: dbMain.databaseBytes,
          tables: dbMain.tables,
          indexes: dbMain.indexes,
          named: dbMain.named,
          vectorProbe: dbMain.vectorProbe,
          statements: dbMain.statements,
          jobRuns: dbMain.jobs,
        }
      : null,
    replicaMetrics: dbMain?.metrics ?? null,
    k6Thresholds: main
      ? Object.fromEntries(
          Object.entries(main.metrics)
            .filter(([, m]) => m.thresholds)
            .map(([name, m]) => [name, Object.values(m.thresholds).every((t) => t.ok)]),
        )
      : null,
  };
  writeJson('report.json', report);
  writeFileSync(resolve(runDir, 'report.md'), markdown(report));
  console.log('Wrote report.json and report.md');
}

function markdown(r) {
  const lines = [];
  const push = (...l) => lines.push(...l);
  push(`# Scale harness results: \`${r.profile}\`, ${r.date}`, '');
  push(
    `Commit \`${r.commit ?? 'unknown'}\`; ${r.setup.apiReplicas} API replica(s) behind the web proxy; stub model: first token after ${r.setup.stub.firstTokenMs} ms, ${r.setup.stub.tokensPerSecond} tokens/s, ${r.setup.stub.replyTokens} tokens a reply.`,
    '',
  );
  push(
    `Hardware: ${r.hardware.cpu ?? 'unknown CPU'}, ${r.hardware.memory ?? '?'} memory${r.hardware.os ? `, ${r.hardware.os}` : ''}; Docker: ${r.hardware.dockerCpus ?? '?'} CPUs, ${r.hardware.dockerMemory ?? '?'} memory. Everything (PostgreSQL, Redis, API, web, stub, k6) shares that machine.`,
    '',
  );
  if (r.setup.load) {
    const v = r.setup.load.vus;
    push(
      `Load: sign-in storm at ${r.setup.load.signinRate}/s for ${r.setup.load.signinHoldSeconds} s (after a ${r.setup.load.signinRampSeconds} s ramp), then ${r.setup.load.steadySeconds} s of mixed load with ${v.browse} browsing, ${v.chat} chatting, ${v.search} searching, ${v.project} project-chatting, ${v.admin} admin and ${v.jobs} job-running virtual users, each a signed-in person with think time.`,
      '',
    );
  }
  if (r.dataset) {
    const c = r.dataset.counts;
    push('## Dataset', '');
    push('| Table | Rows |', '| --- | ---: |');
    for (const [table, count] of Object.entries(c)) push(`| ${table} | ${fmtInt(count)} |`);
    push('');
    push(
      `Generated in ${r.dataset.seconds.toFixed(0)} s (COPY phase ${r.dataset.loadSeconds.toFixed(0)} s at ${fmtInt(r.dataset.rowsPerSecondLoad)} rows/s, ${fmtInt(r.dataset.messagesPerSecondLoad)} messages/s; ${fmtInt(r.dataset.rowsPerSecondOverall)} rows/s including derived tables, index rebuilds and VACUUM). Database after generation: ${fmtGiB(r.dataset.databaseBytes)}. Embeddings: ${r.dataset.dimensions} dimensions.`,
      '',
    );
  }
  push('## Latency by scenario (ms)', '');
  push(
    '| Scenario | p50 | p95 | p99 | n | Target (p95) | Met | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: |',
  );
  for (const s of r.scenarios) {
    push(
      `| ${s.label} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} | ${fmtInt(s.count)} | ${s.target === null ? '' : `< ${s.target}`} | ${s.met === null ? '' : s.met ? 'yes' : '**no**'} | ${pct(s.errorRate)} |`,
    );
  }
  push(
    '',
    '"Reply start added by OCI" is the time from sending the message to the stub model receiving the request: everything OCI does before the model is asked. The stub\'s own first-token delay is excluded; the relay of tokens back is measured separately ("relay after the last token").',
    '',
  );
  if (r.jobs.length > 0) {
    push('## Background jobs under load', '');
    push(
      '| Job | Runs | Items | p50 run (ms) | p95 run (ms) | Items per busy second | Items per minute |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const j of r.jobs) {
      push(
        `| ${j.job} (${j.unit}) | ${fmtInt(j.runs)} | ${fmtInt(j.items)} | ${fmtMs(j.p50Ms)} | ${fmtMs(j.p95Ms)} | ${j.itemsPerBusySecond === null ? '–' : j.itemsPerBusySecond.toFixed(1)} | ${j.itemsPerMinute === null ? '–' : j.itemsPerMinute.toFixed(0)} |`,
      );
    }
    push('');
  }
  if (r.retention.jobs.some((j) => j.ms !== null)) {
    push('## Retention under load', '');
    push('| Job | Duration (ms) | Rows deleted |', '| --- | ---: | ---: |');
    for (const j of r.retention.jobs) push(`| ${j.job} | ${fmtMs(j.ms)} | ${fmtInt(j.items)} |`);
    push(
      '',
      `While they ran: sidebar p95 ${fmtMs(r.retention.during.sidebarP95)} ms, conversation opening p95 ${fmtMs(r.retention.during.conversationP95)} ms, errors ${pct(r.retention.during.errors)}.`,
      '',
    );
  }
  if (r.database) {
    push('## Database', '');
    push(`Size after the main run: ${fmtGiB(r.database.bytes)}.`, '');
    push(
      '| Table | Rows | Total | Table | Indexes | Dead tuples |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const t of r.database.tables.slice(0, 12)) {
      push(
        `| ${t.name} | ${fmtInt(t.rows)} | ${fmtMiB(t.totalBytes)} | ${fmtMiB(t.tableBytes)} | ${fmtMiB(t.indexBytes)} | ${Math.max(t.rows, t.live) + t.dead > 0 ? pct(t.dead / (Math.max(t.rows, t.live) + t.dead)) : '–'} |`,
      );
    }
    push('', '| Largest indexes | Table | Size | Scans |', '| --- | --- | ---: | ---: |');
    for (const i of r.database.indexes.slice(0, 10)) {
      push(`| ${i.name} | ${i.table} | ${fmtMiB(i.bytes)} | ${fmtInt(i.scans)} |`);
    }
    push('');
    if (r.database.named) {
      push('### Named queries (pg_stat_statements, main run)', '');
      push('| Query | Calls | Mean (ms) | Max (ms) |', '| --- | ---: | ---: | ---: |');
      for (const q of r.database.named) {
        if (q.calls === 0) continue;
        push(`| ${q.label} | ${fmtInt(q.calls)} | ${q.meanMs.toFixed(2)} | ${fmtInt(q.maxMs)} |`);
      }
      push('');
    }
    if (r.database.vectorProbe) {
      const v = r.database.vectorProbe;
      push('### pgvector exact scans (EXPLAIN ANALYZE after the main run)', '');
      push(
        '| Scope | Passages scanned | Files | Median (ms) | Max (ms) |',
        '| --- | ---: | ---: | ---: | ---: |',
      );
      v.projects.forEach((p, index) => {
        push(
          `| Project with the ${index === 0 ? 'most' : `#${index + 1} most`} passages | ${fmtInt(p.passages)} | ${fmtInt(p.files)} | ${p.medianMs?.toFixed(1) ?? '–'} | ${Number.isFinite(p.maxMs) ? p.maxMs.toFixed(1) : '–'} |`,
        );
      });
      push(
        `| Every embedding, no project filter (top 10) | ${fmtInt(v.global.embeddings)} | | ${v.global.medianMs?.toFixed(1) ?? '–'} | |`,
        '',
      );
    }
    if (r.database.statements) {
      push('### Top queries by total time (pg_stat_statements, main run)', '');
      push(
        '| # | Calls | Total (ms) | Mean (ms) | Max (ms) | Query |',
        '| ---: | ---: | ---: | ---: | ---: | --- |',
      );
      r.database.statements.slice(0, 12).forEach((s, index) => {
        const query = s.query.replace(/\|/g, '\\|').slice(0, 220);
        push(
          `| ${index + 1} | ${fmtInt(s.calls)} | ${fmtInt(s.totalMs)} | ${s.meanMs.toFixed(1)} | ${fmtInt(s.maxMs)} | \`${query}\` |`,
        );
      });
      push('');
    }
  }
  if (r.replicaMetrics?.requestsPerReplica?.length > 1) {
    push(
      `Requests handled per API replica (since each started): ${r.replicaMetrics.requestsPerReplica.map(fmtInt).join(', ')}.`,
      '',
    );
  }
  if (r.replicaMetrics?.routes?.length) {
    push('### Slowest API routes by total time (OCI metrics, all replicas)', '');
    push('| Route | Requests | Mean (ms) |', '| --- | ---: | ---: |');
    for (const route of r.replicaMetrics.routes.slice(0, 10)) {
      push(`| \`${route.route}\` | ${fmtInt(route.count)} | ${route.meanMs.toFixed(1)} |`);
    }
    push('');
  }
  return `${lines.join('\n')}\n`;
}

if (command === 'collect') await collect();
else if (command === 'snapshot') await snapshot();
else if (command === 'render') render();
else {
  console.error(
    'Usage: node report.mjs collect|snapshot|render [--run-dir DIR] [--phase NAME] [--since ISO]',
  );
  process.exit(2);
}
