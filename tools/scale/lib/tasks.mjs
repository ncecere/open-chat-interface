/**
 * Row generators, one per slice of the dataset. Each runs inside a worker with
 * its own database connections and writes its tables through COPY. Every
 * value is derived from (seed, index), so a slice is the same whichever worker
 * writes it and in whatever order.
 */

import { bool, TextCopy, text, ts } from './copy.mjs';
import { DAY_MS, ids, personAttributes, projectTopics } from './plan.mjs';
import { hashString, Rng } from './prng.mjs';
import { ip, MINUTE_MS, projectCreatedMs, USER_AGENTS } from './tasks-common.mjs';
import { sentence, title } from './text.mjs';

export { auditTask } from './tasks-audit.mjs';
export { projectCreatedMs } from './tasks-common.mjs';
export { conversationsTask } from './tasks-conversations.mjs';
export { filesTask } from './tasks-files.mjs';

// ---------------------------------------------------------------------------
// People: user, account, session, user_preference, project
// ---------------------------------------------------------------------------

export async function peopleTask(ctx, from, to) {
  const { sql, seedHash, nowMs, plan } = ctx;
  const id = ids(seedHash);
  const users = await TextCopy.open(sql, 'user', [
    'id',
    'name',
    'email',
    'email_verified',
    'role',
    'banned',
    'ban_reason',
    'organization_id',
    'last_seen_at',
    'created_at',
    'updated_at',
  ]);
  const accounts = await TextCopy.open(sql, 'account', [
    'id',
    'user_id',
    'account_id',
    'provider_id',
    'password',
    'created_at',
    'updated_at',
  ]);
  const sessions = await TextCopy.open(sql, 'session', [
    'id',
    'user_id',
    'token',
    'expires_at',
    'ip_address',
    'user_agent',
    'created_at',
    'updated_at',
  ]);
  const preferences = await TextCopy.open(sql, 'user_preference', [
    'id',
    'user_id',
    'theme',
    'density',
    'onboarded_at',
    'created_at',
    'updated_at',
  ]);
  const projects = await TextCopy.open(sql, 'project', [
    'id',
    'organization_id',
    'user_id',
    'name',
    'instructions',
    'created_at',
    'updated_at',
  ]);
  const { personConvStart, personProjectStart } = plan;

  for (let i = from; i < to; i++) {
    const rng = new Rng(seedHash, hashString('person'), i);
    const person = personAttributes(seedHash, i, nowMs);
    const userId = id.person(i);
    const conversations = personConvStart[i + 1] - personConvStart[i];
    const lastSeen =
      conversations > 0 ? nowMs - Math.min(300, rng.pareto(0.9) - 1) * DAY_MS : person.joinedMs;
    users.row([
      userId,
      text(person.name),
      person.email,
      't',
      person.role,
      bool(person.banned),
      person.banned ? 'Repeated misuse' : '\\N',
      ctx.organizationId,
      ts(Math.max(person.joinedMs, lastSeen)),
      ts(person.joinedMs),
      ts(person.joinedMs),
    ]);
    accounts.row([
      id.account(i),
      userId,
      userId,
      'credential',
      ctx.passwordHash,
      ts(person.joinedMs),
      ts(person.joinedMs),
    ]);
    if (!person.banned && conversations > 0 && rng.chance(0.6)) {
      const created = Math.max(person.joinedMs, nowMs - rng.float() * 25 * DAY_MS);
      sessions.row([
        id.session(i),
        userId,
        rng.token(24),
        ts(created + 30 * DAY_MS),
        ip(seedHash, 0x4001, i),
        text(rng.pick(USER_AGENTS)),
        ts(created),
        ts(created),
      ]);
    }
    if (rng.chance(0.75)) {
      const onboarded = person.joinedMs + rng.range(1, 30) * MINUTE_MS;
      preferences.row([
        id.preference(i),
        userId,
        rng.pick(['dark', 'dark', 'light', 'system']),
        rng.chance(0.85) ? 'comfortable' : 'compact',
        ts(onboarded),
        ts(person.joinedMs),
        ts(onboarded),
      ]);
    }
    for (let p = personProjectStart[i]; p < personProjectStart[i + 1]; p++) {
      const created = projectCreatedMs(seedHash, p, person.joinedMs, nowMs);
      const topics = projectTopics(seedHash, p);
      const instructions = rng.chance(0.5)
        ? `${sentence(rng)} Focus on ${topics[0]} and ${topics[1]}. ${sentence(rng)}`
        : '';
      projects.row([
        id.project(p),
        ctx.organizationId,
        userId,
        text(`${title(rng).slice(0, 60)} ${topics[0]}`.slice(0, 100)),
        text(instructions.slice(0, 8000)),
        ts(created),
        ts(created + rng.float() * (nowMs - created)),
      ]);
    }
    await users.maybeFlush();
    await projects.maybeFlush();
  }
  const rows = {};
  for (const copy of [users, accounts, sessions, preferences, projects]) {
    rows[copy.table] = await copy.end();
  }
  return rows;
}
