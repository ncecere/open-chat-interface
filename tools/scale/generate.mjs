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
import { scrypt as scryptCallback } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import {
  ADMIN_EMAIL,
  buildPlan,
  conversationFlags,
  FILE_STATE,
  ids,
  isLargeProject,
  projectTopics,
} from './lib/plan.mjs';
import { entityId, hash01, hashString, Rng } from './lib/prng.mjs';
import { auditTask, conversationsTask, filesTask, peopleTask } from './lib/tasks.mjs';
import { searchTerms } from './lib/text.mjs';
import { profileNamed } from './profiles.mjs';

const scrypt = promisify(scryptCallback);
const here = dirname(fileURLToPath(import.meta.url));
const EMBEDDING_TABLE = 'project_file_embedding';
const EMBEDDING_MODEL = 'scale-embed';
const INDEX_BACKUP_TABLE = 'oci_scale_index_backup';

/** Tables the generator loads; their secondary indexes are rebuilt after the load. */
const LOADED_TABLES = [
  'user',
  'account',
  'session',
  'user_preference',
  'project',
  'thread',
  'message',
  'attachment',
  'share_link',
  'project_file_index',
  'project_file_chunk',
  'audit_log',
  'usage_event',
  'usage_record',
];

/** The catalog the dataset uses; every model is served by the stub provider. */
export const MODELS = [
  { slug: 'scale-stub', name: 'Scale stub', weight: 0.55, input: 2_500_000, output: 10_000_000 },
  { slug: 'scale-mini', name: 'Scale mini', weight: 0.25, input: 150_000, output: 600_000 },
  {
    slug: 'scale-reasoning',
    name: 'Scale reasoning',
    weight: 0.15,
    input: 3_000_000,
    output: 15_000_000,
    reasoning: true,
  },
  { slug: 'scale-large', name: 'Scale large', weight: 0.05, input: 10_000_000, output: 30_000_000 },
];

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

function log(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${message}`);
}

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

/** Better Auth's scrypt format (`salt:key`, hex), with a salt fixed by the seed. */
async function passwordHash(password, seedHash) {
  const salt = new Rng(seedHash, hashString('password-salt')).hex(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${key.toString('hex')}`;
}

async function restoreDroppedIndexes(sql) {
  const [exists] = await sql`select to_regclass(${INDEX_BACKUP_TABLE}) is not null as found`;
  if (!exists.found) return 0;
  const saved = await sql.unsafe(`select name, definition from ${INDEX_BACKUP_TABLE}`);
  for (const { definition } of saved) {
    await sql.unsafe(
      definition.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS '),
    );
  }
  await sql.unsafe(`drop table ${INDEX_BACKUP_TABLE}`);
  return saved.length;
}

async function preflight(sql, options) {
  const [schema] = await sql`
    select to_regclass('message') is not null as migrated,
           (select rolsuper from pg_roles where rolname = current_user) as superuser,
           exists (select 1 from pg_available_extensions where name = 'vector') as pgvector
  `;
  if (!schema.migrated)
    throw new Error('The database is not migrated; run the API migration first');
  if (!schema.superuser) {
    throw new Error(
      'The generator needs a superuser (it disables foreign-key triggers while loading)',
    );
  }
  if (!schema.pgvector) throw new Error('pgvector is not installed on this PostgreSQL server');
  const restored = await restoreDroppedIndexes(sql);
  if (restored) log(`Restored ${restored} indexes left dropped by an interrupted run`);
  const [{ people, messages }] = await sql`
    select (select count(*) from "user")::int as people, (select count(*) from message)::int as messages
  `;
  if ((people > 0 || messages > 0) && !options.reset) {
    throw new Error(
      `The database already has ${people} people and ${messages} messages. Use --reset to replace them (this deletes all conversations and accounts).`,
    );
  }
  if (options.reset) {
    log('Deleting existing data (--reset)');
    await sql.unsafe(`
      truncate "user", project, thread, message, attachment, share_link, project_file_index,
        project_file_chunk, project_file_embedding_failure, audit_log, usage_event, usage_record,
        quota_denial, quota_policy, storage_usage, session, account, verification,
        user_preference, provider, model, job_run, deleted_object cascade
    `);
    await sql`delete from instance_setting where key = 'embeddings'`;
  }
}

async function setUpCatalog(sql, options, organizationId, seedHash) {
  const providerId = entityId(seedHash, 'provider', 0);
  await sql`
    insert into provider (id, organization_id, kind, label, base_url, enabled)
    values (${providerId}, ${organizationId}, 'openai-compatible', 'Scale stub (synthetic)', ${options.stubUrl}, true)
  `;
  for (const [index, model] of MODELS.entries()) {
    await sql`
      insert into model (organization_id, provider_id, slug, upstream_model_id, display_name,
        description, capabilities, context_window, max_output_tokens, supported_efforts,
        input_price_micros, output_price_micros, visible_to_roles, enabled, is_default, sort_order)
      values (${organizationId}, ${providerId}, ${model.slug}, ${model.slug}, ${model.name},
        'Synthetic model served by the scale-test stub.', '[]'::jsonb, 128000, 16000,
        ${sql.json(model.reasoning ? ['instant', 'low', 'medium', 'high'] : [])},
        ${model.input}, ${model.output}, ${sql.json(['admin', 'auditor', 'user', 'restricted'])},
        true, ${index === 0}, ${index})
    `;
  }
  const embeddings = {
    enabled: true,
    providerId,
    modelId: EMBEDDING_MODEL,
    dimensions: options.dimensions,
    inputPriceMicros: 20_000,
  };
  await sql`
    insert into instance_setting (organization_id, key, value)
    values (${organizationId}, 'embeddings', ${sql.json(embeddings)})
    on conflict (organization_id, key) do update set value = excluded.value, updated_at = now()
  `;
  // A budget that is evaluated on every message but never reached, so admission
  // reads usage events as it would with a real policy in place.
  const [policy] = await sql`
    insert into quota_policy (organization_id, name, description, metric, limit_value, window_kind, timezone)
    values (${organizationId}, 'Monthly budget', 'Scale-test policy; evaluated, never reached.',
      'cost', 1000000000000, 'monthly', 'UTC')
    returning id
  `;
  await sql`insert into quota_policy_role (policy_id, role) values (${policy.id}, 'user')`;
  return {
    providerId,
    policyId: policy.id,
    modelKey: `${providerId}/${EMBEDDING_MODEL}/${options.dimensions}`,
  };
}

/** The same table the API creates at runtime (apps/api/src/services/embeddings/storage.ts). */
async function ensureEmbeddingTable(sql, dimensions) {
  await sql`create extension if not exists vector`;
  const [current] = await sql`
    select a.atttypmod as dimensions from pg_attribute a
    where a.attrelid = to_regclass(${EMBEDDING_TABLE}) and a.attname = 'embedding' and not a.attisdropped
  `;
  if (current && Number(current.dimensions) === dimensions) {
    await sql.unsafe(`truncate ${EMBEDDING_TABLE}`);
    return;
  }
  if (current) await sql.unsafe(`drop table ${EMBEDDING_TABLE}`);
  const [{ schema }] = await sql`
    select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector'
  `;
  await sql.unsafe(`
    create table ${EMBEDDING_TABLE} (
      attachment_id text not null,
      ordinal integer not null,
      model_key text not null,
      embedding "${schema}".vector(${dimensions}) not null,
      embedded_at timestamp with time zone not null default now(),
      constraint project_file_embedding_pk primary key (attachment_id, ordinal),
      constraint project_file_embedding_chunk_fk foreign key (attachment_id, ordinal)
        references project_file_chunk (attachment_id, ordinal) on delete cascade
    )
  `);
}

async function dropSecondaryIndexes(sql) {
  const indexes = await sql`
    select i.indexrelid::regclass::text as name, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and c.relname = any(${LOADED_TABLES})
      and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
  `;
  await sql.unsafe(
    `create table ${INDEX_BACKUP_TABLE} (name text primary key, definition text not null)`,
  );
  for (const index of indexes) {
    await sql`insert into ${sql(INDEX_BACKUP_TABLE)} (name, definition) values (${index.name}, ${index.definition})`;
  }
  for (const index of indexes) await sql.unsafe(`drop index ${index.name}`);
  return indexes;
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

/** Usage events, rollups, storage counters and denials, derived from the loaded rows. */
async function deriveTables(sql, options, catalog, organizationId) {
  const { usageEvents } = options.profile.dataset;
  const steps = [];
  const step = async (name, run) => {
    const started = performance.now();
    const result = await run();
    steps.push({
      name,
      seconds: (performance.now() - started) / 1000,
      rows: result?.count ?? null,
    });
  };
  await sql.begin(async (tx) => {
    await tx.unsafe('set local session_replication_role = replica');
    await tx.unsafe("set local work_mem = '256MB'");
    // One usage event per generated reply, for the newest replies only: what
    // remains after usage-event retention has pruned the older ones.
    await step('usage_event', () =>
      tx.unsafe(
        `insert into usage_event (id, organization_id, user_id, model_slug, occurred_at, message_count,
           tokens_in, tokens_out, cost_micros, input_price_micros, output_price_micros)
         select md5(m.id || ':usage')::uuid::text, $1, m.user_id, m.model_slug, m.created_at, 1,
           coalesce(m.tokens_in, 0), coalesce(m.tokens_out, 0),
           round((coalesce(m.tokens_in, 0)::numeric * mo.input_price_micros
             + coalesce(m.tokens_out, 0)::numeric * mo.output_price_micros) / 1000000)::bigint,
           mo.input_price_micros, mo.output_price_micros
         from (select * from message where role = 'assistant' order by created_at desc limit $2) m
         join model mo on mo.slug = m.model_slug`,
        [organizationId, usageEvents],
      ),
    );
    // Daily rollups are kept for the whole history (no retention prunes them).
    await step('usage_record', () =>
      tx.unsafe(
        `insert into usage_record (id, organization_id, user_id, model_slug, day, message_count,
           tokens_in, tokens_out, cost_micros, created_at, updated_at)
         select md5(m.user_id || m.model_slug || d.day)::uuid::text, $1, m.user_id, m.model_slug, d.day,
           count(*), sum(coalesce(m.tokens_in, 0)), sum(coalesce(m.tokens_out, 0)),
           sum(round((coalesce(m.tokens_in, 0)::numeric * mo.input_price_micros
             + coalesce(m.tokens_out, 0)::numeric * mo.output_price_micros) / 1000000))::bigint,
           min(m.created_at), max(m.created_at)
         from message m
         join model mo on mo.slug = m.model_slug
         cross join lateral (select to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD') as day) d
         where m.role = 'assistant'
         group by m.user_id, m.model_slug, d.day`,
        [organizationId],
      ),
    );
    await step('storage_usage', () =>
      tx.unsafe(
        `insert into storage_usage (id, organization_id, user_id, live_bytes, live_file_count,
           pending_bytes, pending_file_count)
         select md5(user_id || ':storage')::uuid::text, $1, user_id,
           coalesce(sum(size_bytes) filter (where deleted_at is null), 0),
           count(*) filter (where deleted_at is null),
           coalesce(sum(size_bytes) filter (where deleted_at is not null), 0),
           count(*) filter (where deleted_at is not null)
         from attachment group by user_id`,
        [organizationId],
      ),
    );
    await step('quota_denial', () =>
      tx.unsafe(
        `insert into quota_denial (id, organization_id, user_id, policy_id, policy_name, model_slug,
           day, denial_count)
         select md5(u.id || d::text)::uuid::text, $1, u.id, $2, 'Monthly budget', 'scale-stub',
           to_char(d, 'YYYY-MM-DD'), 1 + abs(hashtext(u.id || d::text)) % 20
         from "user" u
         cross join generate_series($3::timestamptz - interval '60 days', $3::timestamptz, interval '1 day') d
         where abs(hashtext(u.id)) % 100 < 3 and abs(hashtext(u.id || d::text)) % 10 < 2`,
        [organizationId, catalog.policyId, new Date(options.nowMs).toISOString()],
      ),
    );
    await step('sequences', async () => {
      await tx.unsafe(
        "select setval('audit_log_seq_seq', greatest((select max(seq) from audit_log), 1))",
      );
      await tx.unsafe(
        "select setval('message_change_seq', greatest((select max(change_seq) from message), 1))",
      );
    });
  });
  return steps;
}

const FOREIGN_KEYS = [
  ['message', 'thread_id', 'thread', 'id'],
  ['message', 'user_id', '"user"', 'id'],
  ['thread', 'user_id', '"user"', 'id'],
  ['thread', 'project_id', 'project', 'id'],
  ['project', 'user_id', '"user"', 'id'],
  ['attachment', 'message_id', 'message', 'id'],
  ['attachment', 'project_id', 'project', 'id'],
  ['attachment', 'user_id', '"user"', 'id'],
  ['share_link', 'thread_id', 'thread', 'id'],
  ['project_file_index', 'attachment_id', 'attachment', 'id'],
  ['project_file_chunk', 'attachment_id', 'attachment', 'id'],
  ['account', 'user_id', '"user"', 'id'],
  ['session', 'user_id', '"user"', 'id'],
  ['user_preference', 'user_id', '"user"', 'id'],
  ['audit_log', 'actor_user_id', '"user"', 'id'],
  ['usage_event', 'user_id', '"user"', 'id'],
];

async function verify(sql) {
  const problems = [];
  for (const [child, column, parent, key] of FOREIGN_KEYS) {
    const [{ missing }] = await sql.unsafe(
      `select count(*)::int as missing from ${child} c
       where c.${column} is not null and not exists (select 1 from ${parent} p where p.${key} = c.${column})`,
    );
    if (missing > 0)
      problems.push(`${child}.${column}: ${missing} rows reference a missing ${parent}`);
  }
  const [{ orphanEmbeddings }] = await sql.unsafe(
    `select count(*)::int as "orphanEmbeddings" from ${EMBEDDING_TABLE} e
     where not exists (select 1 from project_file_chunk c where c.attachment_id = e.attachment_id and c.ordinal = e.ordinal)`,
  );
  if (orphanEmbeddings > 0) problems.push(`${orphanEmbeddings} embeddings without a passage`);
  const [{ short }] = await sql.unsafe(
    `select count(*)::int as short from thread t
     left join (select thread_id, count(*) as n from message group by thread_id) m on m.thread_id = t.id
     where coalesce(m.n, 0) < 2`,
  );
  if (short > 0) problems.push(`${short} conversations with fewer than two messages`);
  return problems;
}

async function databaseSummary(sql) {
  const [{ bytes }] = await sql`select pg_database_size(current_database()) as bytes`;
  const tables = await sql`
    select c.relname as name, c.reltuples::bigint as rows,
      pg_total_relation_size(c.oid) as total_bytes, pg_relation_size(c.oid) as table_bytes,
      pg_indexes_size(c.oid) as index_bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc limit 15
  `;
  return {
    bytes: Number(bytes),
    tables: tables.map((t) => ({
      name: t.name,
      rows: Number(t.rows),
      totalBytes: Number(t.total_bytes),
      tableBytes: Number(t.table_bytes),
      indexBytes: Number(t.index_bytes),
    })),
  };
}

/** People, project conversations and search terms the load test uses. */
function fixtures(options, plan, seedHash, password) {
  const id = ids(seedHash);
  const { attributes, conversationsPerPerson } = plan;
  const {
    personConvStart,
    convProject,
    projectOwner,
    projectFileStart,
    fileState,
    personProjectStart,
  } = plan.shared;
  const usable = (i) =>
    i !== 0 &&
    !attributes[i].banned &&
    conversationsPerPerson[i] > 0 &&
    attributes[i].role !== 'auditor';

  // One conversation per project owner, in a project with embedded files:
  // large projects first (their messages are answered by searching passages),
  // then ordinary ones so small profiles still have enough distinct owners.
  const projectThreads = [];
  const projectOwners = new Set();
  for (const large of [true, false]) {
    for (let i = 1; i < attributes.length && projectThreads.length < 200; i++) {
      if (!usable(i) || projectOwners.has(i) || personProjectStart[i + 1] === personProjectStart[i])
        continue;
      for (let c = personConvStart[i]; c < personConvStart[i + 1]; c++) {
        const p = convProject[c];
        if (p < 0 || isLargeProject(p) !== large) continue;
        const flags = conversationFlags(seedHash, c);
        if (flags.deleted || flags.temporary || flags.archived) continue;
        let embedded = false;
        for (let f = projectFileStart[p]; f < projectFileStart[p + 1]; f++) {
          if (fileState[f] === FILE_STATE.embedded) embedded = true;
        }
        if (!embedded) continue;
        projectThreads.push({
          email: attributes[projectOwner[p]].email,
          threadId: id.thread(c),
          projectId: id.project(p),
          large,
          terms: projectTopics(seedHash, p),
        });
        projectOwners.add(i);
        break;
      }
    }
  }

  // Everyone else who chats, sampled in proportion to activity (Efraimidis-Spirakis).
  const keyed = [];
  for (let i = 1; i < attributes.length; i++) {
    if (!usable(i) || projectOwners.has(i)) continue;
    const u = hash01(seedHash, 0x5001, i) || 1e-9;
    keyed.push({ i, key: u ** (1 / conversationsPerPerson[i]) });
  }
  keyed.sort((a, b) => b.key - a.key);
  const sample = keyed.slice(0, 800).map(({ i }) => ({
    email: attributes[i].email,
    conversations: conversationsPerPerson[i],
    projects: attributes[i].role !== 'restricted',
  }));
  const half = Math.ceil(sample.length / 2);
  return {
    profile: options.profile.name,
    seed: options.seed,
    now: new Date(options.nowMs).toISOString(),
    password,
    admin: { email: ADMIN_EMAIL },
    model: 'scale-stub',
    browse: sample.slice(0, half),
    chat: sample.slice(half),
    projectThreads,
    searchTerms: searchTerms(),
  };
}

function formatRate(rows, seconds) {
  return seconds > 0 ? Math.round(rows / seconds) : rows;
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
