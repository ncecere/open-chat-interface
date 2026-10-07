// Dataset generator setup: loaded tables, the model catalog, logging, preflight checks,
// the catalog and embedding table, and dropping secondary indexes before the load.

import { scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { entityId, hashString, Rng } from './prng.mjs';

const scrypt = promisify(scryptCallback);

export const EMBEDDING_TABLE = 'project_file_embedding';
const EMBEDDING_MODEL = 'scale-embed';
export const INDEX_BACKUP_TABLE = 'oci_scale_index_backup';

/** Tables the generator loads; their secondary indexes are rebuilt after the load. */
export const LOADED_TABLES = [
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

export function log(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${message}`);
}

/** Better Auth's scrypt format (`salt:key`, hex), with a salt fixed by the seed. */
export async function passwordHash(password, seedHash) {
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

export async function preflight(sql, options) {
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

export async function setUpCatalog(sql, options, organizationId, seedHash) {
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
export async function ensureEmbeddingTable(sql, dimensions) {
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

export async function dropSecondaryIndexes(sql) {
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
