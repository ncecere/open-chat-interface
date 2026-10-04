/**
 * API smoke suite for the rolling-upgrade test: a broad set of the read and
 * write requests a released web client makes, run once against the previous
 * release on the new schema (the window between pre-deploy migrations and
 * replica replacement) and once against the new release.
 *
 * It needs the stack run.mjs builds (an administrator, people with the shared
 * test password and the `upgrade-stub` model). Every step is independent where
 * it can be; a step that depends on an earlier failure is reported as skipped,
 * which also fails the suite.
 *
 * Usage: node smoke.mjs [--base http://127.0.0.1:18480] [--person person002@upgrade.test]
 * Prints JSON; exits 1 if any step fails.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ADMIN,
  Client,
  MODEL_SLUG,
  PERSON_PASSWORD,
  parseArgs,
  personEmail,
  readUiStream,
  signIn,
} from './lib.mjs';

/** Thrown for the API's catch-all 404: the endpoint does not exist in this release. */
class NotInRelease extends Error {}

/**
 * `requireAll`: every endpoint must exist (the new release). Without it, an
 * endpoint the running release does not have yet (the API's catch-all
 * "Route not found") is skipped, not failed: an older client never calls it.
 */
export async function runSmoke({
  bases,
  origin,
  person = personEmail(1),
  label = 'smoke',
  requireAll = false,
}) {
  const steps = [];
  const make = (name) =>
    new Client({ bases, origin, label: name, timeoutMs: 30_000, record: () => {} });
  const admin = make(`${label}-admin`);
  const user = make(`${label}-person`);

  /** Runs one step; `fn` returns a detail string or throws. */
  async function step(name, fn) {
    const started = performance.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - started), detail });
      return true;
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      if (error instanceof NotInRelease && !requireAll) {
        steps.push({
          name,
          ok: true,
          skipped: true,
          ms,
          detail: `not in this release: ${error.message}`,
        });
        return false;
      }
      steps.push({ name, ok: false, ms, detail: error.message });
      return false;
    }
  }
  const skip = (name, why) => steps.push({ name, ok: false, ms: 0, detail: `skipped: ${why}` });

  /** One request; throws unless the status is expected. */
  async function call(client, method, path, { body, expect = [200], check } = {}) {
    const result = await client.request(`${method} ${path}`, method, path, { body, expect });
    if (!result.ok) {
      if (result.status === 404 && result.event?.detail === 'Route not found') {
        throw new NotInRelease(`${method} ${path}`);
      }
      throw new Error(
        `${method} ${path} -> ${result.status || result.error}${result.event?.detail ? `: ${result.event.detail}` : ''}`,
      );
    }
    if (check) {
      const problem = check(result.json, result);
      if (problem) throw new Error(`${method} ${path}: ${problem}`);
    }
    return result;
  }
  const has = (key) => (json) => (json && key in json ? null : `missing "${key}"`);

  // --- Public and authentication -----------------------------------------
  await step('health ready', () => call(admin, 'GET', '/api/health/ready').then(() => 'ok'));
  await step('health live', () => call(admin, 'GET', '/api/health/live').then(() => 'ok'));
  await step('auth status', () => call(admin, 'GET', '/api/auth/status').then(() => 'ok'));
  await step('branding', () =>
    call(admin, 'GET', '/api/branding', { expect: [200, 404] }).then((r) => `HTTP ${r.status}`),
  );
  await step('sign-in with a wrong password is refused', async () => {
    const probe = make(`${label}-probe`);
    const r = await probe.request('bad sign-in', 'POST', '/api/auth/sign-in/email', {
      body: { email: ADMIN.email, password: 'not-the-password-123' },
      expect: [401, 403],
    });
    if (!r.ok) throw new Error(`expected 401, got ${r.status || r.error}`);
    return `HTTP ${r.status}`;
  });
  const adminIn = await step('admin sign-in', async () => {
    const r = await signIn(admin, ADMIN.email, ADMIN.password);
    if (!r.ok) throw new Error(`HTTP ${r.status || r.error}`);
    return 'ok';
  });
  const userIn = await step('person sign-in', async () => {
    const r = await signIn(user, person, PERSON_PASSWORD);
    if (!r.ok) throw new Error(`HTTP ${r.status || r.error}`);
    return 'ok';
  });
  await step('session', () =>
    call(user, 'GET', '/api/auth/get-session', { check: (j) => (j?.user ? null : 'no user') }).then(
      () => 'ok',
    ),
  );

  // --- The person's own settings -----------------------------------------
  if (userIn) {
    await step('me', () => call(user, 'GET', '/api/me', { check: has('user') }).then(() => 'ok'));
    await step('me preferences update', () =>
      call(user, 'PATCH', '/api/me/preferences', { body: { density: 'compact' } })
        .then(() =>
          call(user, 'PATCH', '/api/me/preferences', { body: { density: 'comfortable' } }),
        )
        .then(() => 'ok'),
    );
    await step('me sessions', () =>
      call(user, 'GET', '/api/me/sessions', { check: has('sessions') }).then(() => 'ok'),
    );
    await step('me usage', () => call(user, 'GET', '/api/me/usage').then(() => 'ok'));
    await step('me onboarding', () => call(user, 'GET', '/api/me/onboarding').then(() => 'ok'));
    await step('me broadcasts', () => call(user, 'GET', '/api/me/broadcasts').then(() => 'ok'));
    await step('me share links', () => call(user, 'GET', '/api/me/share-links').then(() => 'ok'));
    await step('memory', () => call(user, 'GET', '/api/memory').then(() => 'ok'));
    await step('model catalogue', () =>
      call(user, 'GET', '/api/models', {
        check: (j) => {
          const list = Array.isArray(j) ? j : (j?.models ?? []);
          return list.some((m) => m.slug === MODEL_SLUG) ? null : `no ${MODEL_SLUG}`;
        },
      }).then(() => 'ok'),
    );
  } else {
    skip('person endpoints', 'person sign-in failed');
  }

  // --- Conversations ------------------------------------------------------
  let threadId = null;
  if (userIn) {
    await step('thread create', async () => {
      const r = await call(user, 'POST', '/api/threads', {
        body: { title: `Smoke ${label} ${Date.now()}` },
        expect: [201],
        check: (j) => (j?.thread?.id ? null : 'no thread id'),
      });
      threadId = r.json.thread.id;
      return threadId;
    });
  }
  if (threadId) {
    await step('chat send and stream to the end', async () => {
      const r = await user.request('chat', 'POST', '/api/chat', {
        body: {
          threadId,
          modelSlug: MODEL_SLUG,
          messages: [
            {
              id: randomUUID(),
              role: 'user',
              parts: [{ type: 'text', text: 'Smoke test: say hello' }],
            },
          ],
        },
        stream: true,
      });
      if (!r.ok)
        throw new Error(`POST /api/chat -> ${r.status || r.error} ${r.event?.detail ?? ''}`);
      const read = await readUiStream(r.response, { timeoutMs: 120_000 });
      if (!read.complete) {
        throw new Error(
          `reply incomplete: ${read.errorText ?? read.readError ?? 'no finish event'}`,
        );
      }
      return `${read.deltas} deltas`;
    });
    await step('stored messages', () =>
      call(user, 'GET', `/api/chat/${threadId}/messages`, {
        check: (j) => {
          const last = j?.messages?.at(-1);
          if (j?.messages?.length !== 2) return `expected 2 messages, got ${j?.messages?.length}`;
          return last?.metadata?.status === 'complete'
            ? null
            : `last status ${last?.metadata?.status}`;
        },
      }).then(() => '2 messages'),
    );
    await step('no active stream to resume', () =>
      call(user, 'GET', `/api/chat/${threadId}/stream`, { expect: [204] }).then(() => '204'),
    );
    await step('thread read', () => call(user, 'GET', `/api/threads/${threadId}`).then(() => 'ok'));
    await step('thread rename and pin', () =>
      call(user, 'PATCH', `/api/threads/${threadId}`, {
        body: { title: 'Smoke renamed', pinned: true },
      }).then(() => 'ok'),
    );
    await step('sidebar lists it', () =>
      call(user, 'GET', '/api/threads?view=sidebar', {
        check: (j) => (j?.threads?.some((t) => t.id === threadId) ? null : 'not listed'),
      }).then(() => 'ok'),
    );
    await step('history page', () =>
      call(user, 'GET', '/api/threads?view=history&limit=20', { check: has('threads') }).then(
        () => 'ok',
      ),
    );
    await step('search', () =>
      call(user, 'GET', '/api/threads/search?q=upgrade&limit=5', { check: has('results') }).then(
        (r) => `${r.json.results.length} results`,
      ),
    );
    await step('export markdown', () =>
      call(user, 'GET', `/api/threads/${threadId}/export`).then((r) => `${r.text.length} bytes`),
    );
    await step('archive and unarchive', () =>
      call(user, 'PATCH', `/api/threads/${threadId}`, { body: { archived: true } })
        .then(() => call(user, 'PATCH', `/api/threads/${threadId}`, { body: { archived: false } }))
        .then(() => 'ok'),
    );
    await step('trash, list trash, restore', () =>
      call(user, 'DELETE', `/api/threads/${threadId}`)
        .then(() =>
          call(user, 'GET', '/api/threads/trash', {
            check: (j) => (j?.threads?.some((t) => t.id === threadId) ? null : 'not in trash'),
          }),
        )
        .then(() => call(user, 'POST', `/api/threads/${threadId}/restore`))
        .then(() => 'ok'),
    );
    await step('delete permanently', () =>
      call(user, 'DELETE', `/api/threads/${threadId}`)
        .then(() => call(user, 'DELETE', `/api/threads/${threadId}/permanent`))
        .then(() => 'ok'),
    );
  } else {
    skip('conversation steps', 'thread create failed');
  }

  // --- Projects -----------------------------------------------------------
  if (userIn) {
    let projectId = null;
    await step('project create', async () => {
      const r = await call(user, 'POST', '/api/projects', {
        body: { name: `Smoke ${label}`, instructions: 'Be brief.' },
        expect: [200, 201],
      });
      projectId = r.json?.project?.id ?? r.json?.id;
      if (!projectId) throw new Error('no project id');
      return projectId;
    });
    if (projectId) {
      await step('project list, read, sidebar', () =>
        call(user, 'GET', '/api/projects')
          .then(() => call(user, 'GET', `/api/projects/${projectId}`))
          .then(() => call(user, 'GET', '/api/projects/sidebar'))
          .then(() => 'ok'),
      );
      await step('project update', () =>
        call(user, 'PATCH', `/api/projects/${projectId}`, {
          body: { instructions: 'Be terse.' },
        }).then(() => 'ok'),
      );
      await step('conversation in a project', async () => {
        const r = await call(user, 'POST', '/api/threads', {
          body: { title: 'Smoke project chat', projectId },
          expect: [201],
        });
        await call(user, 'GET', `/api/threads?projectId=${projectId}`, {
          check: (j) => (j?.threads?.some((t) => t.id === r.json.thread.id) ? null : 'not listed'),
        });
        await call(user, 'DELETE', `/api/threads/${r.json.thread.id}`);
        return 'ok';
      });
      await step('project files', () =>
        call(user, 'GET', `/api/projects/${projectId}/files`).then(() => 'ok'),
      );
      await step('project delete', () =>
        call(user, 'DELETE', `/api/projects/${projectId}`).then(() => 'ok'),
      );
    }
  }

  // --- Administration (reads) and access control ----------------------------
  if (adminIn) {
    const reads = [
      ['admin overview', '/api/admin/overview'],
      ['admin setup status', '/api/admin/setup-status'],
      ['admin users', '/api/admin/users'],
      ['admin roles', '/api/admin/roles'],
      ['admin providers', '/api/admin/providers'],
      ['admin models', '/api/admin/models'],
      ['admin usage overview', '/api/admin/usage/overview?days=7'],
      ['admin usage spend', '/api/admin/usage/spend?days=7'],
      ['admin usage limits', '/api/admin/usage/limits'],
      ['admin usage storage', '/api/admin/usage/storage'],
      ['admin audit', '/api/admin/audit'],
      ['admin settings', '/api/admin/settings'],
      ['admin system health', '/api/admin/health'],
    ];
    for (const [name, path] of reads)
      await step(name, () => call(admin, 'GET', path).then(() => 'ok'));
    await step('admin user detail', async () => {
      const list = await call(
        admin,
        'GET',
        `/api/admin/users?search=${encodeURIComponent(person)}`,
      );
      const users = list.json?.users ?? list.json?.items ?? [];
      const found = users.find((u) => u.email === person) ?? users[0];
      if (!found) throw new Error('person not in the user list');
      await call(admin, 'GET', `/api/admin/users/${found.id}`);
      return 'ok';
    });
  } else {
    skip('administration', 'admin sign-in failed');
  }
  if (userIn) {
    await step('a person cannot read administration', () =>
      call(user, 'GET', '/api/admin/overview', { expect: [403] }).then(() => '403'),
    );
  }
  await step('sign-out', () =>
    call(user, 'POST', '/api/auth/sign-out', { body: {} }).then(() => 'ok'),
  );

  const failed = steps.filter((s) => !s.ok);
  const skipped = steps.filter((s) => s.skipped).length;
  return {
    passed: failed.length === 0,
    total: steps.length,
    failed: failed.length,
    skipped,
    steps,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2), {
    base: { default: 'http://127.0.0.1:18480' },
    origin: { default: '' },
    person: { default: personEmail(1) },
    'require-all': { type: 'boolean', default: false },
  });
  const bases = options.base.split(',');
  const result = await runSmoke({
    bases,
    origin: options.origin || bases[0],
    person: options.person,
    requireAll: options['require-all'],
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
