// Scale report measurements: backlog counts, replica metrics, named queries and the
// pgvector probe.

import { lookup } from 'node:dns/promises';

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

export async function backlog(sql) {
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

export async function scrapeReplicas() {
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

export const NAMED_QUERIES = [
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
