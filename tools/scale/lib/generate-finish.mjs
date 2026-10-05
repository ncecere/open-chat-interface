// Dataset generator after the load: derived tables, verification, the database summary
// and the load-test fixtures.

import { EMBEDDING_TABLE } from './generate-setup.mjs';
import {
  ADMIN_EMAIL,
  conversationFlags,
  FILE_STATE,
  ids,
  isLargeProject,
  projectTopics,
} from './plan.mjs';
import { hash01 } from './prng.mjs';
import { searchTerms } from './text.mjs';

/** Usage events, rollups, storage counters and denials, derived from the loaded rows. */
export async function deriveTables(sql, options, catalog, organizationId) {
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

export async function verify(sql) {
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

export async function databaseSummary(sql) {
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
export function fixtures(options, plan, seedHash, password) {
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

export function formatRate(rows, seconds) {
  return seconds > 0 ? Math.round(rows / seconds) : rows;
}
