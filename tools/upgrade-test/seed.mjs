/**
 * Seeds the previous release's database for the rolling-upgrade test.
 *
 * 1. Through the API, as a client would: sign in as the initial administrator,
 *    add the stub model's provider and model, and create people.
 * 2. Through SQL, for volume: conversations and messages for those people,
 *    generated with `INSERT ... SELECT generate_series(...)`, and usage events:
 *    one per seeded reply plus others spread over two months (several models,
 *    embeddings and reranking, deleted accounts, a few unsettled
 *    reservations), so TO's usage-rollup backfill has real work to do.
 *
 * The SQL is built from `information_schema` at run time rather than written
 * against one release's columns: known columns get meaningful values, and any
 * other NOT NULL column without a default gets a neutral value for its type.
 * So the generator keeps working as `thread` and `message` gain columns.
 */
import { ADMIN, Client, MODEL_SLUG, PERSON_PASSWORD, personEmail, psql, signIn } from './lib.mjs';

/** Words used in seeded text; the load searches for them. */
export const WORDS = [
  'aurora',
  'basalt',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'glacier',
  'harbor',
  'indigo',
  'juniper',
  'kelvin',
  'lagoon',
  'meridian',
  'nebula',
  'obsidian',
  'prairie',
  'quartz',
  'reef',
  'savanna',
  'tundra',
  'umber',
  'vertex',
  'willow',
  'zenith',
];

export async function setupThroughApi({ bases, origin, people, stubUrl, log }) {
  const admin = new Client({ bases, origin, label: 'setup', timeoutMs: 60_000 });
  const signedIn = await signIn(admin, ADMIN.email, ADMIN.password);
  if (!signedIn.ok)
    throw new Error(`Admin sign-in failed: HTTP ${signedIn.status} ${signedIn.text ?? ''}`);

  const provider = await admin.request('provider', 'POST', '/api/admin/providers', {
    body: {
      kind: 'openai-compatible',
      label: 'Upgrade test stub',
      baseUrl: stubUrl,
      apiKey: 'stub-key',
    },
    expect: [201],
  });
  if (!provider.ok)
    throw new Error(`Creating the provider failed: ${provider.status} ${provider.text}`);
  const model = await admin.request('model', 'POST', '/api/admin/models', {
    body: {
      providerId: provider.json.id,
      upstreamModelId: MODEL_SLUG,
      slug: MODEL_SLUG,
      displayName: 'Upgrade stub',
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      isDefault: true,
      visibleToRoles: ['admin', 'user'],
    },
    expect: [201],
  });
  if (!model.ok) throw new Error(`Creating the model failed: ${model.status} ${model.text}`);

  const created = [];
  for (let n = 1; n <= people; n++) {
    const email = personEmail(n);
    const r = await admin.request('user', 'POST', '/api/admin/users', {
      body: { email, name: `Person ${n}`, password: PERSON_PASSWORD, role: 'user' },
      expect: [201],
    });
    if (!r.ok) throw new Error(`Creating ${email} failed: ${r.status} ${r.text}`);
    created.push(email);
  }
  log?.(`created provider, model ${MODEL_SLUG} and ${created.length} people through the API`);
  return created;
}

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** A neutral value for a NOT NULL column the generator does not know. */
function neutral(column) {
  const type = column.type;
  if (/^(text|character varying|character|citext)$/.test(type)) return "''";
  if (/^(smallint|integer|bigint|numeric|real|double precision)$/.test(type)) return '0';
  if (type === 'boolean') return 'false';
  if (type === 'jsonb' || type === 'json') return `'{}'::${type}`;
  if (type.startsWith('timestamp') || type === 'date') return 'now()';
  if (type === 'uuid') return 'gen_random_uuid()';
  if (type === 'ARRAY') return `'{}'`;
  throw new Error(
    `Cannot seed ${column.table}.${column.name}: NOT NULL ${type} without a default. Teach seed.mjs a value for it.`,
  );
}

async function columnsOf(table, env) {
  const rows = await psql(
    `select column_name, data_type, is_nullable, coalesce(column_default, ''), is_identity, is_generated
       from information_schema.columns
      where table_schema = 'public' and table_name = ${literal(table)}
      order by ordinal_position;`,
    env,
  );
  return rows
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, type, nullable, def, identity, generated] = line.split('\t');
      return {
        table,
        name,
        type,
        nullable: nullable === 'YES',
        hasDefault: def !== '' || identity === 'YES' || generated === 'ALWAYS',
        generated: generated === 'ALWAYS',
      };
    });
}

/** `known` maps column names to SQL expressions; unknown required columns get neutral values. */
function projection(columns, known) {
  const names = [];
  const values = [];
  for (const column of columns) {
    if (column.generated) continue;
    if (column.name in known) {
      names.push(`"${column.name}"`);
      values.push(known[column.name]);
    } else if (!column.nullable && !column.hasDefault) {
      names.push(`"${column.name}"`);
      values.push(neutral(column));
    }
  }
  return { names: names.join(', '), values: values.join(',\n         ') };
}

/**
 * Seeds `threads` conversations of `perThread` messages each, spread over the
 * people. Returns counts and timings.
 */
export async function seedConversations({ env, threads, perThread, log }) {
  const started = Date.now();
  const words = `ARRAY[${WORDS.map(literal).join(',')}]`;
  const n = WORDS.length;
  const word = (expr) => `(${words})[1 + ((${expr}) % ${n})]`;

  const threadColumns = await columnsOf('thread', env);
  const messageColumns = await columnsOf('message', env);
  if (!threadColumns.length || !messageColumns.length)
    throw new Error('thread/message tables not found');

  const t = projection(threadColumns, {
    id: 'gen_random_uuid()::text',
    organization_id: 'u.organization_id',
    user_id: 'u.id',
    title: `'Seeded ' || ${word('g')} || ' ' || ${word('g / 7')} || ' #' || g`,
    created_at: `now() - (g * interval '1 minute') - interval '1 day'`,
    updated_at: `now() - (g * interval '1 minute')`,
    last_message_at: `now() - (g * interval '1 minute')`,
  });
  await psql(
    `insert into "thread" (${t.names})
       select ${t.values}
         from generate_series(1, ${threads}) as g
         join (select id, organization_id, (row_number() over (order by email)) - 1 as rn
                 from "user" where email like 'person%@upgrade.test') u
           on u.rn = g % (select count(*) from "user" where email like 'person%@upgrade.test');`,
    env,
  );
  const threadMs = Date.now() - started;

  const assistantText = `${word('t.rn + p')} || ' ' || ${word('t.rn * 3 + p')} || ' ' || ${word('p * 5 + t.rn')} || ' — seeded assistant reply ' || p || '. ' || repeat('The rolling upgrade keeps every replica serving while the schema changes underneath it. ', 12) || md5(t.id || p::text)`;
  const userText = `'Tell me about ' || ${word('t.rn + p')} || ' and ' || ${word('t.rn + 2 * p')} || ' (' || p || ')'`;
  const m = projection(messageColumns, {
    id: 'gen_random_uuid()::text',
    thread_id: 't.id',
    user_id: 't.user_id',
    role: `case when p % 2 = 0 then 'user' else 'assistant' end`,
    parts: `jsonb_build_array(jsonb_build_object('type', 'text', 'text', case when p % 2 = 0 then ${userText} else ${assistantText} end))`,
    position: 'p',
    status: `'complete'`,
    model_slug: `case when p % 2 = 1 then ${literal(MODEL_SLUG)} end`,
    created_at: `t.created_at + (p * interval '1 second')`,
    updated_at: `t.created_at + (p * interval '1 second')`,
  });
  const batch = 1000;
  for (let from = 1; from <= threads; from += batch) {
    const to = Math.min(threads, from + batch - 1);
    await psql(
      `insert into "message" (${m.names})
         select ${m.values}
           from (select id, user_id, created_at, row_number() over (order by created_at desc, id) as rn
                   from "thread" where title like 'Seeded %') t
           cross join generate_series(0, ${perThread - 1}) as p
          where t.rn between ${from} and ${to};`,
      env,
    );
    log?.(`  messages for conversations ${from}-${to} of ${threads}`);
  }
  await psql('vacuum analyze "thread"; vacuum analyze "message";', env, { tuples: false });
  const [messageCount, messageSize] = (
    await psql(
      `select count(*), pg_size_pretty(pg_total_relation_size('message')) from "message";`,
      env,
    )
  )
    .trim()
    .split('\t');
  return {
    threads,
    messagesPerThread: perThread,
    messages: Number(messageCount),
    messageTableSize: messageSize,
    threadMs,
    totalMs: Date.now() - started,
  };
}

/** Chat models the seeded usage is spread over (the first is the stub the load uses). */
export const USAGE_MODELS = [MODEL_SLUG, 'gpt-4o-mini', 'claude-sonnet-4', 'llama-3.3-70b'];
/** Models with usage but no messages, as embeddings and reranking record. */
export const NON_CHAT_MODELS = ['embedding:text-small', 'rerank:fast'];

/**
 * Seeds about `total` usage events, through SQL generated from FROM's
 * `usage_event` columns like the conversations:
 *
 * - one event per seeded assistant reply, at the reply's time, for its
 *   person, over the chat models;
 * - the rest spread over the last 60 days: a third embeddings and reranking
 *   (no messages), one in twelve with the account deleted (`user_id` null,
 *   when FROM's column allows it, as it does from v0.10.0), one in a thousand
 *   an unsettled reservation, one in a hundred with usage unknown.
 *
 * Run after `seedConversations`. Returns counts and timings.
 */
export async function seedUsageEvents({ env, total, log }) {
  const started = Date.now();
  const columns = await columnsOf('usage_event', env);
  if (!columns.length) return { skipped: 'FROM has no usage_event table', events: 0 };
  const userIdNullable = columns.find((column) => column.name === 'user_id')?.nullable === true;
  const chat = `ARRAY[${USAGE_MODELS.map(literal).join(',')}]`;
  const other = `ARRAY[${NON_CHAT_MODELS.map(literal).join(',')}]`;
  const nChat = USAGE_MODELS.length;
  const prices = {
    input_price_micros: '2500000',
    output_price_micros: '10000000',
  };

  // Replies: one event each (pending false: they finished).
  const replies = projection(columns, {
    id: 'gen_random_uuid()::text',
    organization_id: 't.organization_id',
    user_id: 'm.user_id',
    model_slug: `(${chat})[1 + ((hashtext(m.id)::bigint & 2147483647) % ${nChat})]`,
    occurred_at: `m.created_at + interval '2 seconds'`,
    message_count: '1',
    tokens_in: 'r.tokens_in',
    tokens_out: 'r.tokens_out',
    cost_micros: '(r.tokens_in * 2500 + r.tokens_out * 10000) / 1000',
    ...prices,
    pending: 'false',
    usage_unknown: 'false',
    reserved_cost_micros: '0',
    reserved_tokens: '0',
  });
  const replyCount = Number(
    (
      await psql(
        `select count(*) from "message" m join "thread" t on t.id = m.thread_id
          where t.title like 'Seeded %' and m.role = 'assistant';`,
        env,
      )
    ).trim(),
  );
  const fromReplies = Math.min(replyCount, total);
  await psql(
    `insert into "usage_event" (${replies.names})
       select ${replies.values}
         from (select m.id, m.user_id, m.created_at, m.thread_id
                 from "message" m join "thread" t on t.id = m.thread_id
                where t.title like 'Seeded %' and m.role = 'assistant'
                order by m.created_at desc limit ${fromReplies}) m
         join "thread" t on t.id = m.thread_id
         cross join lateral (select 200 + ((hashtext(m.id || 'i')::bigint & 2147483647) % 4000) as tokens_in,
                                    40 + ((hashtext(m.id || 'o')::bigint & 2147483647) % 900) as tokens_out) r;`,
    env,
  );

  // The rest, spread over two months, in batches.
  const rest = Math.max(0, total - fromReplies);
  const people = `(select id, organization_id, (row_number() over (order by email)) - 1 as rn
                     from "user" where email like 'person%@upgrade.test')`;
  const person = `(select count(*) from "user" where email like 'person%@upgrade.test')`;
  const nonChat = 'g % 3 = 0';
  const pending = 'g % 1000 = 7';
  const spread = projection(columns, {
    id: 'gen_random_uuid()::text',
    organization_id: 'u.organization_id',
    user_id: userIdNullable ? `case when g % 12 = 5 then null else u.id end` : 'u.id',
    model_slug: `case when ${nonChat} then (${other})[1 + (g / 3) % 2] else (${chat})[1 + g % ${nChat}] end`,
    occurred_at: `now() - ((hashtext(g::text)::bigint & 2147483647) % (60 * 86400))::double precision * interval '1 second' - interval '1 minute'`,
    message_count: `case when ${nonChat} then 0 else 1 end`,
    tokens_in: `case when ${pending} then 0 else 50 + (hashtext(g::text || 'i')::bigint & 2147483647) % 6000 end`,
    tokens_out: `case when ${pending} or ${nonChat} then 0 else 20 + (hashtext(g::text || 'o')::bigint & 2147483647) % 1200 end`,
    cost_micros: `case when ${pending} then 0 else ((hashtext(g::text || 'c')::bigint & 2147483647) % 40000) end`,
    ...prices,
    pending: pending,
    usage_unknown: `g % 100 = 3`,
    reserved_cost_micros: `case when ${pending} then 30000 else 0 end`,
    reserved_tokens: `case when ${pending} then 5000 else 0 end`,
  });
  const batch = 50_000;
  for (let from = 1; from <= rest; from += batch) {
    const to = Math.min(rest, from + batch - 1);
    await psql(
      `insert into "usage_event" (${spread.names})
         select ${spread.values}
           from generate_series(${from}, ${to}) as g
           join ${people} u on u.rn = g % ${person};`,
      env,
    );
    log?.(`  usage events ${fromReplies + from}-${fromReplies + to} of ${total}`);
  }
  await psql('vacuum analyze "usage_event";', env, { tuples: false });
  const [events, deleted, models, pendingCount, size] = (
    await psql(
      `select count(*), count(*) filter (where user_id is null), count(distinct model_slug),
              count(*) filter (where pending), pg_size_pretty(pg_total_relation_size('usage_event'))
         from "usage_event";`,
      env,
    )
  )
    .trim()
    .split('\t');
  return {
    events: Number(events),
    fromReplies,
    deletedAccounts: Number(deleted),
    deletedAccountsPossible: userIdNullable,
    models: Number(models),
    pending: Number(pendingCount),
    tableSize: size,
    totalMs: Date.now() - started,
  };
}

/** Seeded conversation ids per person, for the load to open. */
export async function seededThreadsFor(emails, env, limit = 40) {
  const rows = await psql(
    `select u.email, t.id from "user" u
       join lateral (select id from "thread" where user_id = u.id and title like 'Seeded %'
                     order by updated_at desc limit ${limit}) t on true
      where u.email in (${emails.map(literal).join(',')});`,
    env,
  );
  const map = new Map(emails.map((e) => [e, []]));
  for (const line of rows.trim().split('\n').filter(Boolean)) {
    const [email, id] = line.split('\t');
    map.get(email)?.push(id);
  }
  return map;
}
