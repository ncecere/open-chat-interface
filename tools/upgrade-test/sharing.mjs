/**
 * Project sharing and groups across the upgrade (v0.14, #394; SPEC-groups.md
 * "Rolling upgrade"). Migrations 0053 and 0054 only add tables, so a previous
 * release serves on the new schema; what must hold while it does:
 *
 * - a share or group made by the new release is invisible to the previous one,
 *   which can only ever show an owner their own data (404 for a recipient;
 *   the recipient's conversation in a shared project hidden from their sidebar
 *   but still in their history);
 * - the previous release's owner flows are unchanged (list, read, rename,
 *   upload, remove a file, and delete a project, which cascades the shares);
 * - the mixed-version guard refuses to create a share while a replica of the
 *   older release is live (409 "upgrade in progress");
 * - nothing is lost: every row and file still there afterwards, counters equal
 *   to the rows; and once every replica is new, the shares work, files an editor
 *   added reach the owner when the editor's account is deleted, and the rollback
 *   statement in docs/OPERATIONS.md detaches other people's conversations.
 *
 * The shares and the group are written with SQL, as the new release would
 * write them if the guard did not apply (it cannot be bypassed through the API
 * while a previous-release replica heartbeats); the data is what the previous
 * release has to cope with. Steps are reported like the smoke suite's.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN, Client, compose, must, PERSON_PASSWORD, psql, signIn } from './lib.mjs';

/** The statement docs/OPERATIONS.md gives to run after rolling back: other people's conversations leave projects they cannot see. */
export const ROLLBACK_SQL = `UPDATE thread SET project_id = NULL
WHERE project_id IS NOT NULL
  AND user_id <> (SELECT p.user_id FROM project p WHERE p.id = thread.project_id);`;

function steps() {
  const list = [];
  return {
    list,
    async step(name, fn) {
      const started = performance.now();
      try {
        const detail = await fn();
        list.push({
          name,
          ok: true,
          ms: Math.round(performance.now() - started),
          detail: detail ?? 'ok',
        });
      } catch (error) {
        list.push({
          name,
          ok: false,
          ms: Math.round(performance.now() - started),
          detail: error.message,
        });
      }
    },
  };
}

const expectEqual = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const sqlId = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function rows(env, sql) {
  const out = await psql(sql, env);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

async function one(env, sql) {
  return (await rows(env, sql))[0]?.[0] ?? null;
}

/** Counters equal the rows, for everyone who has files. */
async function storageDrift(env) {
  return rows(
    env,
    `select u.user_id from (select user_id, coalesce(sum(size_bytes) filter (where deleted_at is null),0) as b from attachment group by user_id) u
     left join storage_usage s on s.user_id = u.user_id
     where coalesce(s.live_bytes,0) <> u.b;`,
  );
}

/** A signed-in client for one person, through the web proxies. */
async function clientFor({ bases, origin }, email, label) {
  const client = new Client({ bases, origin, label, timeoutMs: 30_000, record: () => {} });
  const result = await signIn(client, email, PERSON_PASSWORD);
  if (!result.ok) throw new Error(`sign-in of ${email}: HTTP ${result.status || result.error}`);
  return client;
}

async function adminClient({ bases, origin }) {
  const client = new Client({
    bases,
    origin,
    label: 'sharing-admin',
    timeoutMs: 30_000,
    record: () => {},
  });
  const result = await signIn(client, ADMIN.email, ADMIN.password);
  if (!result.ok) throw new Error(`admin sign-in: HTTP ${result.status || result.error}`);
  return client;
}

async function upload(client, base, name, body) {
  const form = new FormData();
  form.append('files', new File([body], name, { type: 'text/plain' }));
  const response = await fetch(`${base}/api/projects/${client.__project}/files`, {
    method: 'POST',
    headers: { cookie: client.cookieHeader(), origin: client.origin },
    body: form,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/**
 * People and data for the whole check, made with the previous release serving:
 * an owner, a direct editor, a direct viewer, a group member; two projects.
 */
export async function seedSharing({ env, bases, origin, emails, log }) {
  if (emails.length < 5) return { skipped: `needs 5 people, have ${emails.length}` };
  const [ownerEmail, editorEmail, viewerEmail, memberEmail, freshEmail] = emails.slice(-6, -1);
  const ctx = { env, bases, origin, ownerEmail, editorEmail, viewerEmail, memberEmail, freshEmail };
  ctx.owner = await clientFor(ctx, ownerEmail, 'sharing-owner');
  // Through the previous release's own API: an owner creates projects and uploads a file.
  const created = await ctx.owner.request('create project', 'POST', '/api/projects', {
    body: { name: 'Shared plan', instructions: 'Use the PLAN-RULE.' },
    expect: [201],
  });
  const second = await ctx.owner.request('create second project', 'POST', '/api/projects', {
    body: { name: 'Doomed plan' },
    expect: [201],
  });
  if (!created.ok || !second.ok) throw new Error('could not create the owner’s projects');
  ctx.project = created.json.project.id;
  ctx.doomed = second.json.project.id;
  ctx.owner.__project = ctx.project;
  const uploaded = await upload(
    ctx.owner,
    bases[0],
    'owner-notes.txt',
    'OWNER-CANARY notes for the plan',
  );
  if (uploaded.status !== 201) throw new Error(`owner upload: HTTP ${uploaded.status}`);

  const id = async (email) => one(env, `select id from "user" where email = ${sqlId(email)};`);
  ctx.ids = {
    owner: await id(ownerEmail),
    editor: await id(editorEmail),
    viewer: await id(viewerEmail),
    member: await id(memberEmail),
    fresh: await id(freshEmail),
  };
  ctx.group = randomUUID();
  ctx.editorFile = randomUUID();
  ctx.viewerThread = randomUUID();
  ctx.memberThread = randomUUID();
  ctx.doomedThread = randomUUID();
  const org = await one(env, `select id from organization limit 1;`);
  // What the new release would have written: a group, shares, a file an editor
  // added to the owner's project, and recipients' own conversations in it.
  await psql(
    `
    insert into "group" (id, organization_id, name) values (${sqlId(ctx.group)}, ${sqlId(org)}, 'Upgrade group');
    insert into group_member (group_id, user_id) values (${sqlId(ctx.group)}, ${sqlId(ctx.ids.member)}), (${sqlId(ctx.group)}, ${sqlId(ctx.ids.owner)});
    insert into project_share (project_id, subject_type, subject_user_id, permission, created_by_user_id) values
      (${sqlId(ctx.project)}, 'person', ${sqlId(ctx.ids.viewer)}, 'viewer', ${sqlId(ctx.ids.owner)}),
      (${sqlId(ctx.project)}, 'person', ${sqlId(ctx.ids.editor)}, 'editor', ${sqlId(ctx.ids.owner)}),
      (${sqlId(ctx.doomed)}, 'person', ${sqlId(ctx.ids.viewer)}, 'viewer', ${sqlId(ctx.ids.owner)});
    insert into project_share (project_id, subject_type, subject_group_id, permission, created_by_user_id)
      values (${sqlId(ctx.project)}, 'group', ${sqlId(ctx.group)}, 'viewer', ${sqlId(ctx.ids.owner)});
    insert into attachment (id, organization_id, user_id, project_id, filename, mime_type, size_bytes, storage_key, extracted_text)
      values (${sqlId(ctx.editorFile)}, ${sqlId(org)}, ${sqlId(ctx.ids.editor)}, ${sqlId(ctx.project)}, 'editor-notes.txt', 'text/plain', 64, ${sqlId(`upgrade-test/${ctx.editorFile}`)}, 'EDITOR-CANARY notes');
    insert into storage_usage (organization_id, user_id, live_bytes, live_file_count) values (${sqlId(org)}, ${sqlId(ctx.ids.editor)}, 64, 1)
      on conflict (user_id) do update set live_bytes = storage_usage.live_bytes + 64, live_file_count = storage_usage.live_file_count + 1;
    insert into thread (id, organization_id, user_id, project_id, title) values
      (${sqlId(ctx.viewerThread)}, ${sqlId(org)}, ${sqlId(ctx.ids.viewer)}, ${sqlId(ctx.project)}, 'Viewer chat in a shared project'),
      (${sqlId(ctx.memberThread)}, ${sqlId(org)}, ${sqlId(ctx.ids.member)}, ${sqlId(ctx.project)}, 'Member chat in a shared project'),
      (${sqlId(ctx.doomedThread)}, ${sqlId(org)}, ${sqlId(ctx.ids.viewer)}, ${sqlId(ctx.doomed)}, 'Viewer chat in a doomed project');
    `,
    env,
  );
  ctx.before = {
    ownerFiles: Number(
      await one(env, `select count(*) from attachment where user_id = ${sqlId(ctx.ids.owner)};`),
    ),
  };
  log(
    `sharing: project ${ctx.project} shared with a viewer, an editor and a group; ${ctx.doomed} shared with the viewer`,
  );
  return ctx;
}

/** The previous release serves (on the new schema): it must see nothing extra, and its owner flows must work. */
export async function checkPreviousRelease(ctx, log) {
  if (ctx.skipped) return [{ name: 'sharing', ok: true, ms: 0, detail: `skipped: ${ctx.skipped}` }];
  const { step, list } = steps();
  const { env } = ctx;
  const viewer = await clientFor(ctx, ctx.viewerEmail, 'sharing-viewer');
  const member = await clientFor(ctx, ctx.memberEmail, 'sharing-member');

  await step('previous release: a recipient gets 404 for a shared project', async () => {
    for (const client of [viewer, member]) {
      for (const path of [`/api/projects/${ctx.project}`, `/api/projects/${ctx.project}/files`]) {
        const r = await client.request('shared read', 'GET', path, { expect: [404] });
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      }
      const content = await client.request(
        'shared download',
        'GET',
        `/api/attachments/${ctx.editorFile}/content`,
        { expect: [404] },
      );
      if (!content.ok) throw new Error(`download: HTTP ${content.status}`);
    }
    return '404 for read, files and download, for a direct and a group recipient';
  });
  await step(
    'previous release: a shared project is not in the recipient’s list or sidebar',
    async () => {
      for (const path of ['/api/projects', '/api/projects/sidebar']) {
        const r = await viewer.request('lists', 'GET', path);
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        expectEqual(
          (r.json.projects ?? []).map((p) => p.id),
          [],
          `${path} projects`,
        );
      }
      return 'absent';
    },
  );
  await step(
    'previous release: the recipient’s conversation in a shared project is hidden from the sidebar but still in History',
    async () => {
      const sidebar = await viewer.request('sidebar threads', 'GET', '/api/threads?view=sidebar');
      const history = await viewer.request('history', 'GET', '/api/threads?view=history');
      if (!sidebar.ok || !history.ok) throw new Error('could not list conversations');
      const inSidebar = sidebar.json.threads.some((t) => t.id === ctx.viewerThread);
      const inHistory = history.json.threads.some((t) => t.id === ctx.viewerThread);
      if (!inHistory) throw new Error('the conversation is missing from History');
      // Hidden from the sidebar's project tree is what matters; the flat list may show it.
      return `in History; flat sidebar list ${inSidebar ? 'shows' : 'omits'} it`;
    },
  );
  await step(
    'previous release: the owner reads, renames, uploads and removes a file, unchanged',
    async () => {
      const own = await ctx.owner.request('own list', 'GET', '/api/projects');
      if (!own.ok || !own.json.projects.some((p) => p.id === ctx.project))
        throw new Error('owner’s list lacks the project');
      const read = await ctx.owner.request('own read', 'GET', `/api/projects/${ctx.project}`);
      if (!read.ok || read.json.project.name !== 'Shared plan')
        throw new Error('owner read failed');
      const files = await ctx.owner.request(
        'own files',
        'GET',
        `/api/projects/${ctx.project}/files`,
      );
      if (!files.ok) throw new Error('files failed');
      expectEqual(
        files.json.files.map((f) => f.filename),
        ['owner-notes.txt'],
        'the owner’s files (an editor’s are not the previous release’s to show)',
      );
      const renamed = await ctx.owner.request('rename', 'PATCH', `/api/projects/${ctx.project}`, {
        body: { instructions: 'Use the PLAN-RULE, revised.' },
      });
      if (!renamed.ok) throw new Error('update failed');
      const up = await upload(ctx.owner, ctx.bases[0], 'extra.txt', 'EXTRA-CANARY');
      if (up.status !== 201) throw new Error(`upload: HTTP ${up.status}`);
      const removed = await ctx.owner.request(
        'remove file',
        'DELETE',
        `/api/projects/${ctx.project}/files/${up.json.files[0].id}`,
      );
      if (!removed.ok) throw new Error('remove failed');
      return 'list, read, update, upload, remove';
    },
  );
  await step(
    'previous release: the owner deletes a shared project (shares cascade, the recipient’s conversation is kept and detached)',
    async () => {
      const r = await ctx.owner.request('delete project', 'DELETE', `/api/projects/${ctx.doomed}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      expectEqual(
        await one(
          env,
          `select count(*) from project_share where project_id = ${sqlId(ctx.doomed)};`,
        ),
        '0',
        'shares left',
      );
      expectEqual(
        await one(
          env,
          `select coalesce(project_id, 'detached') from thread where id = ${sqlId(ctx.doomedThread)};`,
        ),
        'detached',
        'the recipient’s conversation',
      );
      return 'cascaded; conversation kept';
    },
  );
  await step(
    'previous release: nothing is lost (the editor’s file and every row are still there)',
    async () => {
      expectEqual(
        await one(env, `select count(*) from attachment where id = ${sqlId(ctx.editorFile)};`),
        '1',
        'editor file',
      );
      expectEqual(
        await one(
          env,
          `select count(*) from project_share where project_id = ${sqlId(ctx.project)};`,
        ),
        '3',
        'shares on the kept project',
      );
      expectEqual(
        await one(
          env,
          `select count(*) from thread where id in (${sqlId(ctx.viewerThread)}, ${sqlId(ctx.memberThread)}) and project_id = ${sqlId(ctx.project)};`,
        ),
        '2',
        'recipients’ conversations',
      );
      return 'intact';
    },
  );
  log(`sharing (previous release): ${list.filter((s) => s.ok).length}/${list.length}`);
  return list;
}

/**
 * One replica of the new release is up beside one of the previous: creating a
 * share is refused there, through the API of that replica itself (inside its
 * container, so the load balancer cannot send the request elsewhere).
 */
export async function checkMixedWindow(ctx, { service, log }) {
  if (ctx.skipped) return [];
  const { step, list } = steps();
  await step(
    `mixed versions: ${service} (new release) refuses to create a share while the previous release is live`,
    async () => {
      const script = `
      const base = 'http://127.0.0.1:3000';
      const origin = ${JSON.stringify(ctx.origin)};
      const jar = new Map();
      const call = async (method, path, body) => {
        const response = await fetch(base + path, {
          method,
          headers: { origin, 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => k + '=' + v).join('; ') },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
        return { status: response.status, json: await response.json().catch(() => null) };
      };
      const signedIn = await call('POST', '/api/auth/sign-in/email', { email: ${JSON.stringify(ctx.ownerEmail)}, password: ${JSON.stringify(PERSON_PASSWORD)} });
      const share = await call('POST', '/api/projects/${ctx.project}/shares', { subject: { type: 'person', email: ${JSON.stringify(ctx.freshEmail)} }, permission: 'viewer' });
      const list = await call('GET', '/api/projects');
      const access = await call('GET', '/api/projects/${ctx.project}/access');
      console.log(JSON.stringify({ signedIn: signedIn.status, share, list, access }));
    `;
      // The previous replica's heartbeat is what the guard reads: give it a moment.
      let result;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const out = await must(
          compose(['exec', '-T', service, 'node', '-e', script], ctx.env),
          `${service} request`,
        );
        result = JSON.parse(out.stdout.trim().split('\n').at(-1));
        if (result.share.status === 409) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (result.signedIn !== 200) throw new Error(`sign-in HTTP ${result.signedIn}`);
      if (
        result.share.status !== 409 ||
        result.share.json?.error?.details?.reason !== 'upgrade_in_progress'
      ) {
        throw new Error(
          `creating a share: HTTP ${result.share.status} ${JSON.stringify(result.share.json)}`,
        );
      }
      expectEqual(
        await one(
          ctx.env,
          `select count(*) from project_share where subject_user_id = ${sqlId(ctx.ids.fresh)};`,
        ),
        '0',
        'shares created despite the refusal',
      );
      if (result.list.status !== 200 || !Array.isArray(result.list.json?.shared))
        throw new Error('the new release’s list has no "shared"');
      if (result.access.status !== 200 || result.access.json?.access !== 'owner')
        throw new Error('the access summary is wrong');
      return '409 upgrade_in_progress; reads work; nothing created';
    },
  );
  log(`sharing (${service}, mixed): ${list.filter((s) => s.ok).length}/${list.length}`);
  return list;
}

/** Every replica runs the new release: the shares written earlier work, and the lifecycle holds. */
export async function checkNewRelease(ctx, log) {
  if (ctx.skipped) return [];
  const { step, list } = steps();
  const { env } = ctx;
  const viewer = await clientFor(ctx, ctx.viewerEmail, 'sharing-viewer2');
  const member = await clientFor(ctx, ctx.memberEmail, 'sharing-member2');
  const admin = await adminClient(ctx);

  await step('new release: the shares made while the previous release served work', async () => {
    const mine = await viewer.request('viewer list', 'GET', '/api/projects');
    if (!mine.ok) throw new Error('list failed');
    expectEqual(
      mine.json.projects.map((p) => p.id),
      [],
      'the viewer owns nothing',
    );
    const shared = mine.json.shared.find((p) => p.id === ctx.project);
    if (shared?.access !== 'viewer') throw new Error('shared project missing or wrong access');
    const viaGroup = await member.request('member list', 'GET', '/api/projects');
    if (
      !viaGroup.ok ||
      !viaGroup.json.shared.some((p) => p.id === ctx.project && p.access === 'viewer')
    ) {
      throw new Error('group recipient does not see it');
    }
    const files = await viewer.request('viewer files', 'GET', `/api/projects/${ctx.project}/files`);
    if (!files.ok) throw new Error('files failed');
    expectEqual(
      files.json.files.map((f) => f.filename).sort(),
      ['editor-notes.txt', 'owner-notes.txt'],
      'files the viewer sees',
    );
    expectEqual(
      files.json.files.find((f) => f.filename === 'editor-notes.txt').addedBy.length > 0,
      true,
      'addedBy',
    );
    const sidebar = await viewer.request('viewer sidebar', 'GET', '/api/projects/sidebar');
    const entry = sidebar.json.shared.find((p) => p.id === ctx.project);
    if (!entry?.recentThreads.some((t) => t.id === ctx.viewerThread))
      throw new Error('the recipient’s own conversation is not under the shared project');
    if (entry.recentThreads.some((t) => t.id === ctx.memberThread))
      throw new Error('another person’s conversation is listed');
    return 'viewer and group member read; sidebar lists only their own conversation';
  });
  await step(
    'new release: a viewer cannot change anything; an outsider learns nothing',
    async () => {
      for (const [method, path, body] of [
        ['PATCH', `/api/projects/${ctx.project}`, { instructions: 'x' }],
        ['DELETE', `/api/projects/${ctx.project}`],
        ['GET', `/api/projects/${ctx.project}/shares`],
      ]) {
        const r = await viewer.request('viewer write', method, path, { body, expect: [403] });
        if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
      }
      const outsider = await clientFor(ctx, ctx.freshEmail, 'sharing-fresh');
      const r = await outsider.request('outsider', 'GET', `/api/projects/${ctx.project}`, {
        expect: [404],
      });
      if (!r.ok) throw new Error(`outsider read: HTTP ${r.status}`);
      return '403 for a viewer; 404 for an outsider';
    },
  );
  await step(
    'new release: with every replica new, the owner can share through the API',
    async () => {
      let r;
      // A stopped replica leaves the heartbeat list at once, an old one by expiry.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        r = await ctx.owner.request('share', 'POST', `/api/projects/${ctx.project}/shares`, {
          body: { subject: { type: 'person', email: ctx.freshEmail }, permission: 'viewer' },
          expect: [201, 409],
        });
        if (r.status === 201) break;
        await new Promise((res) => setTimeout(res, 5000));
      }
      if (r.status !== 201) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.json)}`);
      ctx.freshShare = r.json.share.id;
      return 'created';
    },
  );
  await step(
    'new release: removing a share detaches the recipient’s conversation and keeps it',
    async () => {
      const shares = await ctx.owner.request(
        'list shares',
        'GET',
        `/api/projects/${ctx.project}/shares`,
      );
      const viewerShare = shares.json.shares.find((s) => s.subject.userId === ctx.ids.viewer);
      const r = await ctx.owner.request(
        'remove share',
        'DELETE',
        `/api/projects/${ctx.project}/shares/${viewerShare.id}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      expectEqual(
        await one(
          env,
          `select coalesce(project_id, 'detached') from thread where id = ${sqlId(ctx.viewerThread)};`,
        ),
        'detached',
        'the viewer’s conversation',
      );
      const after = await viewer.request('viewer read', 'GET', `/api/projects/${ctx.project}`, {
        expect: [404],
      });
      if (!after.ok) throw new Error(`HTTP ${after.status}`);
      expectEqual(
        await one(env, `select count(*) from thread where id = ${sqlId(ctx.viewerThread)};`),
        '1',
        'conversation kept',
      );
      return 'detached, kept, access ended';
    },
  );
  await step(
    'new release: deleting an editor’s account hands the files they added to the owner',
    async () => {
      const r = await admin.request(
        'delete editor',
        'DELETE',
        `/api/admin/users/${ctx.ids.editor}`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.text?.slice(0, 200)}`);
      expectEqual(
        await one(
          env,
          `select user_id = ${sqlId(ctx.ids.owner)} from attachment where id = ${sqlId(ctx.editorFile)};`,
        ),
        't',
        'the file’s owner',
      );
      return 'file kept, now the owner’s';
    },
  );
  await step('new release: counters equal the rows, and the owner lost nothing', async () => {
    const drift = await storageDrift(env);
    expectEqual(drift, [], 'users whose storage counter differs from their files');
    const ownerFiles = Number(
      await one(env, `select count(*) from attachment where user_id = ${sqlId(ctx.ids.owner)};`),
    );
    // The owner's file, plus the editor's that was handed over.
    expectEqual(ownerFiles, ctx.before.ownerFiles + 1, 'owner’s files');
    return `${ownerFiles} files, counters agree`;
  });
  await step(
    'rollback note: the documented statement detaches other people’s conversations from a project',
    async () => {
      // A conversation of the member's in the project, as the new release left it.
      await psql(ROLLBACK_SQL, env);
      expectEqual(
        await one(
          env,
          `select coalesce(project_id, 'detached') from thread where id = ${sqlId(ctx.memberThread)};`,
        ),
        'detached',
        'the member’s conversation',
      );
      expectEqual(
        await one(env, `select count(*) from thread where id = ${sqlId(ctx.memberThread)};`),
        '1',
        'kept',
      );
      return 'detached and kept';
    },
  );
  log(`sharing (new release): ${list.filter((s) => s.ok).length}/${list.length}`);
  return list;
}
