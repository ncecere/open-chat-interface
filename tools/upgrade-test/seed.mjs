/**
 * Seeds the previous release's database for the rolling-upgrade test.
 *
 * 1. Through the API, as a client would: sign in as the initial administrator,
 *    add the stub model's provider and model, and create people.
 * 2. Through SQL, for volume: conversations and messages for those people,
 *    generated with `INSERT ... SELECT generate_series(...)`.
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
