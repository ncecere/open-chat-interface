// Database probes: post-deploy steps, secret formats, background migrations, usage rollups.

import { ADMIN, Client, psql, signIn } from '../lib.mjs';
import { bases, env, origin } from './context.mjs';

/** Post-deploy steps recorded by `migrate --post`. */
export async function postSteps() {
  const out = await psql(
    `select name, coalesce(duration_ms, -1), attempts, finished_at is not null
       from oci_post_migration order by name;`,
    env,
  ).catch(() => '');
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, durationMs, attempts, finished] = line.split('\t');
      return {
        name,
        durationMs: Number(durationMs) < 0 ? null : Number(durationMs),
        attempts: Number(attempts),
        finished: finished === 't',
      };
    });
}

/**
 * Stored secrets by format (v0.11 design, item 23): values encrypted with
 * ENCRYPTION_KEY in the versioned format (`oci:v1:<key id>:`), which a v0.10
 * replica cannot read, and in the format before it.
 */
export async function secretFormats() {
  const out = await psql(
    `select count(*) filter (where v like 'oci:v1:%'), count(*) filter (where v not like 'oci:v1:%')
       from (
         select encrypted_api_key as v from provider where encrypted_api_key is not null
         union all select encrypted_secret from webhook_endpoint
         union all select encrypted_shared_header_value from connector
           where encrypted_shared_header_value is not null
         union all select encrypted_oauth_client_secret from connector
           where encrypted_oauth_client_secret is not null
         union all select encrypted_tokens from connector_account where encrypted_tokens is not null
         union all select encrypted_pending from connector_account where encrypted_pending is not null
       ) secrets;`,
    env,
  ).catch(() => '');
  const [versioned, legacy] = out.trim().split('\t').map(Number);
  return { versioned: versioned || 0, legacy: legacy || 0 };
}

/**
 * While a previous-release replica still serves: an administrator re-enters
 * the provider's key (through either web proxy, so through both releases),
 * and the new release must keep storing it in the format the previous one
 * reads, or the previous release's chats (the load) would fail to decrypt it.
 */
export async function secretsDuringUpgrade() {
  const admin = new Client({ bases, origin, label: 'secrets', timeoutMs: 30_000 });
  const signedIn = await signIn(admin, ADMIN.email, ADMIN.password);
  const [providerId] = (await psql('select id from provider order by created_at limit 1;', env))
    .trim()
    .split('\n');
  let saved = 0;
  for (let attempt = 0; signedIn.ok && attempt < 8; attempt++) {
    const response = await admin.request(
      'provider-key',
      'PATCH',
      `/api/admin/providers/${providerId}`,
      {
        body: { apiKey: 'stub-key' },
        expect: [200],
      },
    );
    if (response.ok) saved++;
  }
  return { saved, attempts: 8, ...(await secretFormats()) };
}

/** Background migrations and their progress. */
export async function backgroundMigrations() {
  const out = await psql(
    `select name, status, rows_processed, batches, attempts, coalesce(last_error, ''),
            coalesce(throttled_reason, ''),
            coalesce((extract(epoch from started_at) * 1000)::bigint, 0),
            coalesce((extract(epoch from finished_at) * 1000)::bigint, 0)
       from background_migration order by name;`,
    env,
  ).catch(() => '');
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, status, rows, batches, attempts, lastError, throttled, started, finished] =
        line.split('\t');
      return {
        name,
        status,
        rowsProcessed: Number(rows),
        batches: Number(batches),
        attempts: Number(attempts),
        lastError: lastError || null,
        throttledReason: throttled || null,
        startedAt: Number(started) || null,
        finishedAt: Number(finished) || null,
        ms: Number(started) && Number(finished) ? Number(finished) - Number(started) : null,
      };
    });
}

/** The usage-rollup backfill (migration 0040, v0.11); its rollups are checked after it. */
export const USAGE_ROLLUP_BACKFILL = '0.11.usage-rollups';

const ROLLUP_AMOUNTS = [
  'events',
  'settled_events',
  'messages',
  'tokens_in',
  'tokens_out',
  'cost_micros',
  'quota_messages',
  'quota_tokens',
  'quota_cost_micros',
];
const MODEL_AMOUNTS = ROLLUP_AMOUNTS.slice(0, 6);

/**
 * Compares the usage rollups with the raw events, in one statement (one
 * snapshot, so the load's writes and the fold job cannot make them disagree
 * mid-check): every (UTC hour, person, model) of `usage_rollup_hour` plus the
 * change log not folded yet, and every (hour, model) of
 * `usage_rollup_model_hour` plus the log, against a `group by` over every
 * event, amount by amount (docs/dev/database.md, "Usage rollups"). A rollup
 * key whose amounts all net to zero is no key. Null when TO has no rollups.
 */
export async function usageRollupCheck() {
  const [exists] = (
    await psql(`select to_regclass('usage_rollup_hour') is not null;`, env).catch(() => 'f')
  ).trim();
  if (exists !== 't') return null;
  const eventAmounts = `count(*) as events,
      count(*) filter (where not pending) as settled_events,
      coalesce(sum(message_count) filter (where not pending), 0) as messages,
      coalesce(sum(tokens_in) filter (where not pending), 0) as tokens_in,
      coalesce(sum(tokens_out) filter (where not pending), 0) as tokens_out,
      coalesce(sum(cost_micros) filter (where not pending), 0) as cost_micros,
      sum(message_count) as quota_messages,
      sum(tokens_in::bigint + tokens_out + reserved_tokens) as quota_tokens,
      sum(cost_micros + reserved_cost_micros) as quota_cost_micros`;
  const sums = (names) => names.map((name) => `sum(${name})::bigint as ${name}`).join(', ');
  const nonZero = (names) => `not (${names.map((name) => `sum(${name}) = 0`).join(' and ')})`;
  const differs = (names) =>
    `(${names.map((n) => `e.${n}`).join(', ')}) is distinct from (${names.map((n) => `r.${n}`).join(', ')})`;
  const out = await psql(
    `with e as (
       select date_trunc('hour', occurred_at, 'UTC') as hour, user_id, model_slug, ${eventAmounts}
       from usage_event group by 1, 2, 3
     ), em as (
       select hour, model_slug, ${sums(MODEL_AMOUNTS)} from e group by 1, 2
     ), r as (
       select hour, user_id, model_slug, ${sums(ROLLUP_AMOUNTS)}
       from (select hour, user_id, model_slug, ${ROLLUP_AMOUNTS.join(', ')} from usage_rollup_hour
             union all
             select hour, user_id, model_slug, ${ROLLUP_AMOUNTS.join(', ')} from usage_rollup_change) x
       group by 1, 2, 3 having ${nonZero(ROLLUP_AMOUNTS)}
     ), rm as (
       select hour, model_slug, ${sums(MODEL_AMOUNTS)}
       from (select hour, model_slug, ${MODEL_AMOUNTS.join(', ')} from usage_rollup_model_hour
             union all
             select hour, model_slug, ${MODEL_AMOUNTS.join(', ')} from usage_rollup_change) x
       group by 1, 2 having ${nonZero(MODEL_AMOUNTS)}
     )
     select
       (select count(*) from usage_event),
       (select count(*) from usage_event where in_rollup is not true),
       (select count(*) from usage_event where user_id is null),
       (select count(*) from e),
       (select count(*) from e full join r
          on r.hour = e.hour and r.user_id is not distinct from e.user_id and r.model_slug = e.model_slug
        where ${differs(ROLLUP_AMOUNTS)}),
       (select count(*) from em),
       (select count(*) from em e full join rm r on r.hour = e.hour and r.model_slug = e.model_slug
        where ${differs(MODEL_AMOUNTS)}),
       (select count(*) from usage_rollup_hour),
       (select count(*) from usage_rollup_change),
       (select coalesce(sum(events), 0) from e), (select coalesce(sum(events), 0) from r),
       (select coalesce(sum(cost_micros), 0) from e), (select coalesce(sum(cost_micros), 0) from r),
       (select coalesce(sum(quota_tokens), 0) from e), (select coalesce(sum(quota_tokens), 0) from r);`,
    env,
  );
  const [
    events,
    unmarked,
    deletedAccounts,
    personKeys,
    personDiffering,
    modelKeys,
    modelDiffering,
    rollupRows,
    unfolded,
    eventsTotal,
    rollupEventsTotal,
    costTotal,
    rollupCostTotal,
    quotaTokensTotal,
    rollupQuotaTokensTotal,
  ] = out.trim().split('\t').map(Number);
  return {
    events,
    unmarked,
    deletedAccounts,
    personKeys,
    personDiffering,
    modelKeys,
    modelDiffering,
    rollupRows,
    unfolded,
    totals: {
      events: [eventsTotal, rollupEventsTotal],
      costMicros: [costTotal, rollupCostTotal],
      quotaTokens: [quotaTokensTotal, rollupQuotaTokensTotal],
    },
    exact:
      unmarked === 0 &&
      personDiffering === 0 &&
      modelDiffering === 0 &&
      eventsTotal === rollupEventsTotal &&
      costTotal === rollupCostTotal &&
      quotaTokensTotal === rollupQuotaTokensTotal,
  };
}

export async function appliedMigrationTimes() {
  const out = await psql(
    'select created_at from drizzle.__drizzle_migrations order by created_at;',
    env,
  );
  return out.trim().split('\n').filter(Boolean).map(Number);
}
