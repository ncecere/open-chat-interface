#!/usr/bin/env node
/**
 * Embedding rebuild measurement (docs/dev/scale-harness.md, "Embedding
 * generations"). Runs in the `tools` container against a kept stack:
 *
 *   node rebuild.mjs --model scale-embed-2 --run-dir /results
 *
 * 1. Signs in as the generated administrator.
 * 2. With one generation: times uploads of project files (each embeds its
 *    passages in the request) and the vector store's search statement on the
 *    largest projects.
 * 3. Saves another embeddings model, which starts a rebuild (a second
 *    generation filled by the `embeddings.rebuild` job).
 * 4. Until searches switch: samples the rebuild's progress every few seconds,
 *    the search statement on the current generation, and uploads (which now
 *    embed into both generations).
 *
 * Writes rebuild.json to the run directory and prints a summary.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'scale-embed-2' },
    'run-dir': { type: 'string', default: '/results' },
    'timeout-minutes': { type: 'string', default: '40' },
    uploads: { type: 'string', default: '8' },
    'sample-seconds': { type: 'string', default: '5' },
  },
});
const env = process.env;
const BASE = env.SCALE_BASE_URL ?? 'http://web:8080';
const ORIGIN = env.SCALE_ORIGIN ?? 'http://127.0.0.1:18080';
const runDir = args['run-dir'];

function loadPostgres() {
  for (const from of [
    resolve(here, '../../packages/db/package.json'),
    '/app/packages/db/package.json',
  ]) {
    try {
      return createRequire(from)('postgres');
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Cannot load the `postgres` package (run inside the API image)');
}

const postgres = loadPostgres();
const sql = postgres(env.DATABASE_URL, { prepare: false, max: 2, onnotice: () => {} });
const fixtures = JSON.parse(readFileSync(resolve(runDir, 'fixtures.json'), 'utf8'));
let cookie = '';

async function api(method, path, body, headers = {}) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      cookie,
      ...(body !== undefined &&
        !(body instanceof FormData) && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const ms = performance.now() - started;
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { ms, json: text ? JSON.parse(text) : null, response };
}

async function signIn() {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: fixtures.admin.email, password: fixtures.password }),
  });
  if (!response.ok) throw new Error(`Sign-in failed: HTTP ${response.status}`);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
function percentile(values, p) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

async function currentGeneration() {
  const [row] = await sql`
    select id, table_name, model_key from embedding_generation where state = 'current'`;
  return row ?? null;
}

let probeProjects = null;

/** The vector store's search statement on the five largest projects, timed with EXPLAIN ANALYZE. */
async function probeSearch() {
  const generation = await currentGeneration();
  if (!generation) return null;
  const vectors = sql(generation.table_name);
  probeProjects ??= await sql`
    select a.project_id, a.user_id, array_agg(distinct a.id) as file_ids, count(*)::int as passages
    from project_file_chunk c join attachment a on a.id = c.attachment_id
    where a.project_id is not null and a.deleted_at is null
    group by a.project_id, a.user_id order by count(*) desc limit 5
  `;
  const timings = [];
  for (const project of probeProjects) {
    const plan = await sql`
      explain (analyze, format json)
      with q as materialized (
        select embedding from ${vectors} where attachment_id = any(${project.file_ids}) limit 1
      )
      select e.attachment_id, e.ordinal,
        (e.embedding <=> (select embedding from q))::float8 as distance
      from ${vectors} e
      join attachment a on a.id = e.attachment_id
      where a.user_id = ${project.user_id} and a.project_id = ${project.project_id}
        and a.upload_pending = false and a.deleted_at is null
        and e.attachment_id = any(${project.file_ids})
        and e.model_key = ${generation.model_key}
      order by distance, e.attachment_id, e.ordinal
      limit 160
    `;
    const value = plan?.[0]?.['QUERY PLAN']?.[0]?.['Execution Time'];
    if (typeof value === 'number') timings.push(value);
  }
  return { generation: generation.id, medianMs: median(timings), maxMs: Math.max(...timings) };
}

let projectId = null;
let uploadCount = 0;

/** A text file of about 40 passages, different every time. */
function fileText() {
  uploadCount += 1;
  return Array.from({ length: 40 }, (_, index) =>
    Array.from(
      { length: 9 },
      (__, sentence) =>
        `Upload ${uploadCount} section ${index} note ${sentence}: the greenhouse heater log lists readings, settings and the person on duty for the week.`,
    ).join(' '),
  ).join('\n\n');
}

async function upload(fresh = false) {
  if (!projectId || fresh) {
    const created = await api('POST', '/api/projects', {
      name: `Rebuild measurement ${Date.now()}`,
    });
    projectId = created.json.project.id;
  }
  const form = new FormData();
  form.append('files', new Blob([fileText()], { type: 'text/plain' }), `log-${uploadCount}.txt`);
  const { ms, json } = await api('POST', `/api/projects/${projectId}/files`, form);
  return { ms, passages: json.files?.[0]?.index?.passages ?? null };
}

async function uploads(count) {
  const results = [];
  // A project holds at most 20 files: each phase uploads into a new one.
  for (let index = 0; index < count; index += 1) results.push(await upload(index === 0));
  const ms = results.map((result) => result.ms);
  return {
    count,
    passagesEach: results[0]?.passages ?? null,
    medianMs: median(ms),
    p90Ms: percentile(ms, 0.9),
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  await signIn();
  const uploadsPerPhase = Number(args.uploads);
  const before = {
    status: (await api('GET', '/api/admin/embeddings')).json,
    search: await probeSearch(),
    uploads: await uploads(uploadsPerPhase),
  };
  const startGeneration = await currentGeneration();
  console.log(
    `Before: generation ${startGeneration?.id}; search median ${before.search?.medianMs?.toFixed(1)} ms; upload median ${before.uploads.medianMs?.toFixed(0)} ms`,
  );

  const saved = await api('PUT', '/api/admin/embeddings', { modelId: args.model });
  const filling = saved.json.generations.filling;
  if (!filling) throw new Error('Saving the model started no rebuild');
  const startedAt = Date.now();
  console.log(
    `Rebuild to generation ${filling.id} (${args.model}) started: ${filling.passages.total} passages; estimate ${saved.json.estimate.passages} x ${saved.json.estimate.averageTokens} tokens`,
  );

  const samples = [];
  const duringUploads = [];
  const timeoutAt = startedAt + Number(args['timeout-minutes']) * 60_000;
  let switchedAt = null;
  let sample = 0;
  while (Date.now() < timeoutAt) {
    const { json: status, ms } = await api('GET', '/api/admin/embeddings');
    const search = await probeSearch();
    const row = {
      seconds: (Date.now() - startedAt) / 1000,
      statusMs: ms,
      current: status.generations.current?.id ?? null,
      embedded: status.generations.filling?.passages.embedded ?? null,
      total: status.generations.filling?.passages.total ?? null,
      perMinute: status.generations.filling?.perMinute ?? null,
      etaSeconds: status.generations.filling?.etaSeconds ?? null,
      searchMs: search?.medianMs ?? null,
      searchGeneration: search?.generation ?? null,
    };
    samples.push(row);
    if (sample++ % 6 === 0) {
      console.log(
        `${row.seconds.toFixed(0)} s: ${row.embedded ?? '-'} of ${row.total ?? '-'} (${row.perMinute ?? '-'}/min); search ${row.searchMs?.toFixed(1)} ms on generation ${row.searchGeneration}`,
      );
    }
    if (status.generations.current?.id === filling.id) {
      switchedAt = Date.now();
      break;
    }
    // Uploads during the rebuild embed into both generations.
    if (duringUploads.length < uploadsPerPhase && sample % 2 === 0) {
      duringUploads.push(await upload(duringUploads.length === 0));
    }
    await sleep(Number(args['sample-seconds']) * 1000);
  }
  const after = {
    search: await probeSearch(),
    uploads: await uploads(uploadsPerPhase),
    status: (await api('GET', '/api/admin/embeddings')).json,
  };
  const [sizes] = await sql`
    select
      pg_total_relation_size(to_regclass(${startGeneration.table_name}))::bigint as previous_bytes,
      pg_total_relation_size(to_regclass(${`project_file_embedding_g${filling.id}`}))::bigint as new_bytes
  `;
  const fillSeconds = switchedAt ? (switchedAt - startedAt) / 1000 : null;
  const duringSearch = samples
    .filter((row) => row.searchGeneration === startGeneration.id)
    .map((row) => row.searchMs);
  const duringUploadMs = duringUploads.map((result) => result.ms);
  const result = {
    model: args.model,
    generations: { from: startGeneration.id, to: filling.id },
    passages: filling.passages.total,
    estimate: saved.json.estimate,
    fillSeconds,
    passagesPerMinute: fillSeconds ? (filling.passages.total * 60) / fillSeconds : null,
    switched: switchedAt !== null,
    search: {
      before: before.search,
      duringMedianMs: median(duringSearch),
      duringP90Ms: percentile(duringSearch, 0.9),
      duringMaxMs: duringSearch.length ? Math.max(...duringSearch) : null,
      after: after.search,
    },
    uploads: {
      before: before.uploads,
      during: {
        count: duringUploads.length,
        medianMs: median(duringUploadMs),
        p90Ms: percentile(duringUploadMs, 0.9),
      },
      after: after.uploads,
    },
    sizes: { previousBytes: Number(sizes.previous_bytes), newBytes: Number(sizes.new_bytes) },
    samples,
  };
  writeFileSync(resolve(runDir, 'rebuild.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  await sql.end({ timeout: 1 });
}

main().catch(async (error) => {
  console.error(error);
  await sql.end({ timeout: 1 });
  process.exit(1);
});
