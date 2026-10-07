import { json, TextCopy, ts } from './copy.mjs';
import { DAY_MS, ids, personAttributes } from './plan.mjs';
import { hashString, Rng } from './prng.mjs';
import { ip, pickWeighted, USER_AGENTS } from './tasks-common.mjs';
import { word } from './text.mjs';

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const AUDIT_ACTIONS = [
  { weight: 0.62, action: 'auth.signin.local.success', target: 'session', status: 200 },
  { weight: 0.06, action: 'auth.signin.local.failure', target: 'session', status: 401 },
  { weight: 0.08, action: 'auth.signout.success', target: 'session', status: 200 },
  { weight: 0.12, action: 'tool.call', target: 'tool' },
  { weight: 0.03, action: 'thread.export', target: 'thread' },
  { weight: 0.01, action: 'share_link.revoke', target: 'share_link' },
  { weight: 0.02, action: 'auth.password.changed.success', target: 'session', status: 200 },
  { weight: 0.02, action: 'attachment.delete', target: 'attachment' },
  { weight: 0.04, action: 'admin', target: 'admin' },
];
const ADMIN_ACTIONS = ['settings.update', 'user.update', 'provider.update', 'job.run', 'ban'];

export async function auditTask(ctx, from, to, total) {
  const { sql, seedHash, nowMs, plan, adminIndexes } = ctx;
  const id = ids(seedHash);
  const copy = await TextCopy.open(sql, 'audit_log', [
    'id',
    'organization_id',
    'actor_user_id',
    'actor_email',
    'action',
    'target_type',
    'target_id',
    'metadata',
    'ip_address',
    'created_at',
    'seq',
  ]);
  const yearStart = nowMs - 365 * DAY_MS;
  const { convOwner } = plan;
  for (let i = from; i < to; i++) {
    const rng = new Rng(seedHash, hashString('audit'), i);
    // Monotonic in i, denser towards the present as adoption grows; `seq`
    // follows insertion (and so time) order, as the database's sequence does.
    const createdMs = yearStart + 365 * DAY_MS * ((i + rng.float()) / total) ** (2 / 3);
    const kind = pickWeighted(rng, AUDIT_ACTIONS);
    // An actor who had joined by then; the administrator (person 0) has been
    // there since launch.
    let actorIndex = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate =
        convOwner.length > 0 ? convOwner[rng.int(convOwner.length)] : rng.int(ctx.people);
      if (personAttributes(seedHash, candidate, nowMs).joinedMs <= createdMs) {
        actorIndex = candidate;
        break;
      }
    }
    let action = kind.action;
    let targetType = kind.target;
    let targetId = null;
    let metadata;
    if (kind.action === 'admin') {
      const admin = adminIndexes[rng.int(adminIndexes.length)];
      if (personAttributes(seedHash, admin, nowMs).joinedMs <= createdMs) actorIndex = admin;
      else actorIndex = 0;
      action = rng.pick(ADMIN_ACTIONS);
      targetType =
        action === 'settings.update' ? 'settings' : action === 'job.run' ? 'job' : 'user';
      targetId = targetType === 'user' ? id.person(rng.int(ctx.people)) : null;
      metadata = { changed: [word(rng)] };
    } else if (kind.action === 'tool.call') {
      targetId = 'web_search';
      metadata = {
        toolId: 'web_search',
        kind: 'builtin',
        approvalRequired: false,
        approval: null,
        outcome: rng.chance(0.97) ? 'success' : 'error',
      };
    } else if (kind.status) {
      metadata = { status: kind.status, userAgent: rng.pick(USER_AGENTS) };
    } else {
      targetId = id.thread(rng.int(Math.max(1, ctx.conversations)));
      metadata = {};
    }
    const actor = personAttributes(seedHash, actorIndex, nowMs);
    copy.row([
      id.audit(i),
      ctx.organizationId,
      id.person(actorIndex),
      actor.email,
      action,
      targetType,
      targetId ?? '\\N',
      json(metadata),
      ip(seedHash, 0x4001, actorIndex),
      ts(createdMs),
      String(i + 1),
    ]);
    await copy.maybeFlush();
  }
  return { audit_log: await copy.end() };
}
