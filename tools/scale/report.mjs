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

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, command, writeJson } from './lib/report-context.mjs';
import { backlog, NAMED_QUERIES, scrapeReplicas, vectorProbe } from './lib/report-db.mjs';
import { render } from './lib/report-render.mjs';

export { vectorProbe } from './lib/report-db.mjs';

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

function database() {
  const postgres = loadPostgres();
  const url = args['database-url'] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL or pass --database-url');
  return postgres(url, { prepare: false, max: 2, onnotice: () => {} });
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

if (command === 'collect') await collect();
else if (command === 'snapshot') await snapshot();
else if (command === 'render') render();
else {
  console.error(
    'Usage: node report.mjs collect|snapshot|render [--run-dir DIR] [--phase NAME] [--since ISO]',
  );
  process.exit(2);
}
