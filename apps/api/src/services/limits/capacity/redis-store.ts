import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import {
  type CapacityStore,
  DEFAULT_TIMINGS,
  encodeLimits,
  HOUR_MS,
  type ProviderLimits,
  type ScopeStatus,
  type StoreTimings,
  type Ticket,
  type TicketStatus,
} from './store.js';

/**
 * Provider capacity in Redis, shared by every replica (see store.ts for the
 * algorithm). Every change is one Lua script, so a check and its debit are
 * atomic across replicas, and time is Redis's own (`TIME`), never a replica's
 * clock.
 *
 * Keys, all under `oci:capacity:{<provider id>}:` (one hash slot per
 * provider, for Redis Cluster):
 *
 * - `q`: the queue, a sorted set of ticket ids by tag;
 * - `t:<ticket>`: a waiting ticket (model, tokens, state), expiring `aliveMs`
 *   after its owner last polled it;
 * - `last:<person>`: the person's latest tag, for spacing (10 minutes);
 * - `p:` and `m:<model id>:` scopes, each with `rb` and `tb` (request and token
 *   buckets: level and time), `st` (stream leases by expiry) and `cool`
 *   (cool-down after a 429);
 * - `adm`, `thr`, `waits`: admissions in the last minute (for the estimated
 *   wait), provider throttles and waits in the last hour (System health).
 */

const PRELUDE = `
local P = ARGV[1]
local function nowms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local NONE = {-1, -1, -1}
local function level(key, cap, now)
  local h = redis.call('HMGET', key, 'v', 't')
  local v = tonumber(h[1])
  local t = tonumber(h[2])
  if not v or not t then return cap end
  local l = v + (now - t) * cap / 60000
  if l > cap then l = cap end
  return l
end
local function setLevel(key, l, cap, now)
  if l < -cap then l = -cap end
  redis.call('HSET', key, 'v', tostring(l), 't', tostring(now))
  redis.call('PEXPIRE', key, 180000)
end
local function leases(key, now)
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  return redis.call('ZCARD', key)
end
local function hasRoom(s, lim, tokens, now)
  if redis.call('PTTL', s .. 'cool') > 0 then return false end
  if lim[1] >= 0 and level(s .. 'rb', lim[1], now) < 1 then return false end
  if lim[2] >= 0 then
    local need = tokens
    if need > lim[2] then need = lim[2] end
    if level(s .. 'tb', lim[2], now) < need then return false end
  end
  if lim[3] >= 0 and leases(s .. 'st', now) >= lim[3] then return false end
  return true
end
local function debit(s, lim, requests, tokens, now)
  if lim[1] >= 0 then setLevel(s .. 'rb', level(s .. 'rb', lim[1], now) - requests, lim[1], now) end
  if lim[2] >= 0 then setLevel(s .. 'tb', level(s .. 'tb', lim[2], now) - tokens, lim[2], now) end
end
local function lease(s, id, untilMs, ttl)
  redis.call('ZADD', s .. 'st', untilMs, id)
  redis.call('PEXPIRE', s .. 'st', ttl)
end
local function modelLimits(limits, model)
  local m = limits.m[model]
  if m then return m end
  return NONE
end
local function pump(limits, now, pickup, leaseMs, scan)
  local q = P .. 'q'
  local ids = redis.call('ZRANGE', q, 0, scan - 1)
  for _, id in ipairs(ids) do
    local t = P .. 't:' .. id
    local h = redis.call('HMGET', t, 'm', 'k', 's')
    if not h[1] then
      redis.call('ZREM', q, id)
    elseif h[3] == 'w' then
      local tokens = tonumber(h[2])
      if not hasRoom(P .. 'p:', limits.p, tokens, now) then break end
      local ml = modelLimits(limits, h[1])
      local ms = P .. 'm:' .. h[1] .. ':'
      if hasRoom(ms, ml, tokens, now) then
        debit(P .. 'p:', limits.p, 1, tokens, now)
        debit(ms, ml, 1, tokens, now)
        lease(P .. 'p:', id, now + pickup, leaseMs * 4)
        lease(ms, id, now + pickup, leaseMs * 4)
        redis.call('ZREM', q, id)
        redis.call('HSET', t, 's', 'a')
        redis.call('ZADD', P .. 'adm', now, id)
        redis.call('PEXPIRE', P .. 'adm', 120000)
      end
    end
  end
end
local function statusOf(id, now, leaseMs)
  local t = P .. 't:' .. id
  local h = redis.call('HMGET', t, 'm', 's')
  if not h[1] then return {id, 'g', 0, -1} end
  if h[2] == 'a' then
    -- Picked up: full lease term, ticket done.
    redis.call('ZADD', P .. 'p:st', 'XX', now + leaseMs, id)
    redis.call('ZADD', P .. 'm:' .. h[1] .. ':st', 'XX', now + leaseMs, id)
    redis.call('DEL', t)
    return {id, 'a', 0, -1}
  end
  local r = redis.call('ZRANK', P .. 'q', id)
  if not r then return {id, 'g', 0, -1} end
  redis.call('ZREMRANGEBYSCORE', P .. 'adm', '-inf', now - 60000)
  local rate = redis.call('ZCARD', P .. 'adm')
  local eta = -1
  if rate > 0 then eta = math.ceil((r + 1) * 60 / rate) end
  return {id, 'w', r + 1, eta}
end
`;

// ARGV: prefix, limits, id, model, person, tokens, offset, aliveMs, spacingMs,
// handoffTag (-1: none), pickupMs, leaseMs, scan
const ENQUEUE = `${PRELUDE}
local limits = cjson.decode(ARGV[2])
local id = ARGV[3]
local person = ARGV[5]
local alive = tonumber(ARGV[8])
local spacing = tonumber(ARGV[9])
local handoff = tonumber(ARGV[10])
local now = nowms()
local base = now
if handoff >= 0 then
  base = handoff
else
  local last = tonumber(redis.call('GET', P .. 'last:' .. person))
  if last and last + spacing > now then base = last + spacing end
  redis.call('SET', P .. 'last:' .. person, tostring(base), 'PX', 600000)
end
local tag = base + tonumber(ARGV[7])
local t = P .. 't:' .. id
redis.call('HSET', t, 'm', ARGV[4], 'k', ARGV[6], 's', 'w')
redis.call('PEXPIRE', t, alive)
redis.call('ZADD', P .. 'q', tag, id)
pump(limits, now, tonumber(ARGV[11]), tonumber(ARGV[12]), tonumber(ARGV[13]))
local s = statusOf(id, now, tonumber(ARGV[12]))
return {tostring(base), s[2], s[3], s[4]}
`;

// ARGV: prefix, limits, aliveMs, pickupMs, leaseMs, scan, ids...
const POLL = `${PRELUDE}
local limits = cjson.decode(ARGV[2])
local alive = tonumber(ARGV[3])
local now = nowms()
for i = 7, #ARGV do
  local t = P .. 't:' .. ARGV[i]
  if redis.call('HGET', t, 's') == 'w' then redis.call('PEXPIRE', t, alive) end
end
pump(limits, now, tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]))
local out = {}
for i = 7, #ARGV do
  local s = statusOf(ARGV[i], now, tonumber(ARGV[5]))
  table.insert(out, s[2])
  table.insert(out, s[3])
  table.insert(out, s[4])
end
return out
`;

// ARGV: prefix, model, id
const CANCEL = `
local P = ARGV[1]
redis.call('ZREM', P .. 'q', ARGV[3])
redis.call('DEL', P .. 't:' .. ARGV[3])
redis.call('ZREM', P .. 'p:st', ARGV[3])
redis.call('ZREM', P .. 'm:' .. ARGV[2] .. ':st', ARGV[3])
return 1
`;

// ARGV: prefix, model, id, leaseMs
const RENEW = `
local P = ARGV[1]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', P .. 'p:st', 'XX', now + tonumber(ARGV[4]), ARGV[3])
redis.call('ZADD', P .. 'm:' .. ARGV[2] .. ':st', 'XX', now + tonumber(ARGV[4]), ARGV[3])
return 1
`;

// ARGV: prefix, limits, model, requests, tokens
const CHARGE = `${PRELUDE}
local limits = cjson.decode(ARGV[2])
local now = nowms()
local requests = tonumber(ARGV[4])
local tokens = tonumber(ARGV[5])
debit(P .. 'p:', limits.p, requests, tokens, now)
debit(P .. 'm:' .. ARGV[3] .. ':', modelLimits(limits, ARGV[3]), requests, tokens, now)
return 1
`;

// ARGV: prefix, scope ('p:' or 'm:<id>:'), ms
const COOL = `
local key = ARGV[1] .. ARGV[2] .. 'cool'
local ms = tonumber(ARGV[3])
if redis.call('PTTL', key) < ms then redis.call('SET', key, '1', 'PX', ms) end
return 1
`;

// ARGV: prefix, set ('thr' or 'waits'), member, keepMs
const RECORD = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local key = ARGV[1] .. ARGV[2]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - tonumber(ARGV[4]))
redis.call('ZADD', key, now, ARGV[3])
redis.call('PEXPIRE', key, tonumber(ARGV[4]))
return 1
`;

// ARGV: prefix
const STATUS = `
local P = ARGV[1]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', P .. 'p:st', '-inf', now)
redis.call('ZREMRANGEBYSCORE', P .. 'thr', '-inf', now - ${HOUR_MS})
redis.call('ZREMRANGEBYSCORE', P .. 'waits', '-inf', now - ${HOUR_MS})
local queued = 0
for _, id in ipairs(redis.call('ZRANGE', P .. 'q', 0, -1)) do
  if redis.call('HGET', P .. 't:' .. id, 's') == 'w' then queued = queued + 1 end
end
local longest = -1
for _, member in ipairs(redis.call('ZRANGE', P .. 'waits', 0, -1)) do
  local ms = tonumber(string.match(member, ':(%d+)$'))
  if ms and ms > longest then longest = ms end
end
local cool = redis.call('PTTL', P .. 'p:cool')
local coolUntil = -1
if cool > 0 then coolUntil = now + cool end
return {queued, redis.call('ZCARD', P .. 'p:st'), redis.call('ZCARD', P .. 'thr'),
  redis.call('ZCARD', P .. 'waits'), longest, coolUntil}
`;

const sha = (script: string) => createHash('sha1').update(script).digest('hex');
const SCRIPTS = { ENQUEUE, POLL, CANCEL, RENEW, CHARGE, COOL, RECORD, STATUS };
const SHAS = Object.fromEntries(
  Object.entries(SCRIPTS).map(([name, script]) => [name, sha(script)]),
) as Record<keyof typeof SCRIPTS, string>;

export function capacityKeyPrefix(providerId: string): string {
  return `oci:capacity:{${providerId}}:`;
}

function decodeStatus(state: unknown, position: unknown, eta: unknown): TicketStatus {
  if (state === 'a') return { state: 'admitted' };
  if (state === 'w') {
    const seconds = Number(eta);
    return {
      state: 'waiting',
      position: Number(position),
      etaSeconds: seconds >= 0 ? seconds : null,
    };
  }
  return { state: 'gone' };
}

export class RedisCapacityStore implements CapacityStore {
  readonly kind = 'shared' as const;
  private readonly timings: StoreTimings;

  constructor(
    private readonly redis: Redis,
    timings: Partial<StoreTimings> = {},
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  /** EVALSHA, loading the script on first use (or after a Redis restart). */
  private async run(name: keyof typeof SCRIPTS, providerId: string, args: Array<string | number>) {
    // KEYS[1] places the script in the provider's hash slot (Redis Cluster);
    // every key it touches shares that slot.
    const prefix = capacityKeyPrefix(providerId);
    try {
      return await this.redis.evalsha(SHAS[name], 1, `${prefix}q`, prefix, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      return this.redis.eval(SCRIPTS[name], 1, `${prefix}q`, prefix, ...args);
    }
  }

  async enqueue(limits: ProviderLimits, ticket: Ticket) {
    const t = this.timings;
    const reply = (await this.run('ENQUEUE', ticket.providerId, [
      encodeLimits(limits),
      ticket.id,
      ticket.modelId,
      ticket.personId,
      Math.max(0, Math.ceil(ticket.tokens)),
      Math.round(ticket.priorityOffsetMs),
      t.aliveMs,
      t.spacingMs,
      ticket.handoffTag ?? -1,
      t.pickupMs,
      t.leaseMs,
      t.scan,
    ])) as unknown[];
    return { tag: Number(reply[0]), status: decodeStatus(reply[1], reply[2], reply[3]) };
  }

  async poll(limits: ProviderLimits, ticketIds: string[]) {
    const t = this.timings;
    const reply = (await this.run('POLL', limits.providerId, [
      encodeLimits(limits),
      t.aliveMs,
      t.pickupMs,
      t.leaseMs,
      t.scan,
      ...ticketIds,
    ])) as unknown[];
    return new Map(
      ticketIds.map((id, index) => [
        id,
        decodeStatus(reply[index * 3], reply[index * 3 + 1], reply[index * 3 + 2]),
      ]),
    );
  }

  async cancel(providerId: string, modelId: string, ticketId: string) {
    await this.run('CANCEL', providerId, [modelId, ticketId]);
  }

  async renew(providerId: string, modelId: string, leaseId: string) {
    await this.run('RENEW', providerId, [modelId, leaseId, this.timings.leaseMs]);
  }

  async release(providerId: string, modelId: string, leaseId: string) {
    await this.run('CANCEL', providerId, [modelId, leaseId]);
  }

  async charge(limits: ProviderLimits, modelId: string, requests: number, tokens: number) {
    await this.run('CHARGE', limits.providerId, [
      encodeLimits(limits),
      modelId,
      requests,
      Math.round(tokens),
    ]);
  }

  async coolDown(providerId: string, modelId: string | null, ms: number) {
    await this.run('COOL', providerId, [modelId ? `m:${modelId}:` : 'p:', Math.ceil(ms)]);
  }

  async recordThrottle(providerId: string) {
    await this.run('RECORD', providerId, ['thr', crypto.randomUUID(), HOUR_MS]);
  }

  async recordWait(providerId: string, waitedMs: number) {
    await this.run('RECORD', providerId, [
      'waits',
      `${crypto.randomUUID()}:${Math.round(waitedMs)}`,
      HOUR_MS,
    ]);
  }

  async status(providerId: string): Promise<ScopeStatus> {
    const [queued, activeStreams, throttled, waits, longest, coolUntil] = (
      (await this.run('STATUS', providerId, [])) as unknown[]
    ).map(Number) as [number, number, number, number, number, number];
    return {
      queued,
      activeStreams,
      throttledLastHour: throttled,
      waitsLastHour: waits,
      longestWaitMs: longest >= 0 ? longest : null,
      coolingUntil: coolUntil >= 0 ? coolUntil : null,
    };
  }
}
