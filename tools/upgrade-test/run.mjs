#!/usr/bin/env node
/**
 * Rolling-upgrade test (docs/dev/v0.11-design.md section 5; how to run it and
 * what it proves: docs/dev/rolling-upgrades.md).
 *
 * 1. FROM = a published release (default: the newest stable tag older than the
 *    source's version), TO = images built from this checkout (or --to-api/--to-web).
 * 2. PostgreSQL 17 with pgvector, Redis, a stub model, two FROM API replicas
 *    and two web proxies. FROM migrates; people are created through the API and
 *    conversations seeded through SQL against FROM's schema.
 * 3. A steady load runs through the web proxies for the rest of the test.
 * 4. Under load: TO's pre-deploy migrations (the compose `migrate` job), the
 *    smoke suite against FROM on the new schema, then each API replica and web
 *    proxy replaced with TO one at a time (SIGTERM, start TO, wait healthy),
 *    then the post-deploy phase (`migrate --post`: concurrent index builds,
 *    and scheduling the background migrations), then each API replica
 *    restarted on TO (a rolling restart of the new release, which is where
 *    draining on shutdown is measured, while a background migration runs),
 *    then a wait for the background migrations to finish, then the smoke
 *    suite against TO.
 * 5. Verdict and report (report.json, report.md) in --out.
 *
 * `--inject <case>` adds a deliberately unsafe migration to TO (inject.mjs) as
 * a negative control; `--expect-fail` then inverts the exit code.
 *
 * Exit codes: 0 pass, 1 verdict failed, 2 the test itself could not run.
 */

import { fork } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInjectedImage } from './inject.mjs';
import {
  bases,
  env,
  FIRST_DRAINING,
  FIRST_VERSIONED_SECRETS,
  log,
  options,
  origin,
  outDir,
  REGISTRY,
  STABLE,
  startedAt,
  timeline,
} from './lib/context.mjs';
import {
  appliedMigrationTimes,
  backgroundMigrations,
  postSteps,
  secretFormats,
  secretsDuringUpgrade,
  USAGE_ROLLUP_BACKFILL,
  usageRollupCheck,
} from './lib/database.mjs';
import {
  buildFromSource,
  compareVersions,
  ensureImage,
  hostArch,
  localArch,
  readJournal,
  resolveFrom,
} from './lib/images.mjs';
import { startLockMonitor } from './lib/locks.mjs';
import { collectLogs, teardown } from './lib/stack.mjs';
import {
  compose,
  containerId,
  inspect,
  must,
  PERSON_PASSWORD,
  psql,
  REPO_ROOT,
  run,
  sleep,
  TOOL_DIR,
  waitHealthy,
  waitHttp,
} from './lib.mjs';
import { analyse, writeReports } from './report.mjs';
import {
  seedConversations,
  seededThreadsFor,
  seedUsageEvents,
  setupThroughApi,
  WORDS,
} from './seed.mjs';
import { runSmoke } from './smoke.mjs';

async function main() {
  const report = {
    run: { timeline, startedAt: new Date(startedAt).toISOString() },
  };
  const R = report.run;

  if ((await run('docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0) {
    throw new Error('Docker is not available');
  }
  const sourceVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const fromTag = await resolveFrom(sourceVersion);
  R.from = {
    version: fromTag,
    api: `${REGISTRY}/api:${fromTag}`,
    web: `${REGISTRY}/web:${fromTag}`,
  };
  // TO is this source, which drains; a published FROM drains from v0.11.0.
  const fromDrains = STABLE.test(fromTag) && compareVersions(fromTag, FIRST_DRAINING) >= 0;
  R.from.drains = fromDrains;
  log(
    `FROM ${fromTag}${fromDrains ? '' : ' (does not drain on shutdown)'}; source version ${sourceVersion}`,
  );
  // TO is prepared (built from source, or pulled) while FROM's stack starts
  // and is seeded, and awaited before the load begins, so building no longer
  // adds to the run; the API and web images build at the same time.
  const preparingTo = (async () => {
    const [toApi, toWeb] = await Promise.all(
      ['api', 'web'].map(async (app) => {
        const given = options[`to-${app}`];
        if (!given) return buildFromSource(app, sourceVersion);
        await ensureImage(given);
        return given;
      }),
    );
    let effective = toApi;
    let inject;
    if (options.inject) {
      inject = await buildInjectedImage(options.inject, toApi, outDir, log);
      effective = inject.image;
    }
    return { toApi, toWeb, effective, inject, journal: await readJournal(effective) };
  })();
  // Rejections surface where it is awaited; this only keeps Node from
  // reporting one as unhandled while FROM starts.
  preparingTo.catch(() => undefined);

  const host = await hostArch();
  const fromImages = await Promise.all([ensureImage(R.from.api), ensureImage(R.from.web)]);
  R.platform = { host: `linux/${host}`, from: fromImages.map((i) => `linux/${i.arch}`) };
  if (fromImages.some((i) => i.emulated))
    log(`FROM ${fromTag} runs emulated (linux/amd64 on linux/${host}); TO runs natively`);

  R.bounds = {
    stopTimeoutMs: options['stop-timeout'] * 1000,
    p99Ms: options['p99-ms'],
    maxMs: options['max-ms'],
    lockWaitMs: options['lock-wait-ms'],
    allowCutReplies: options['allow-cut-replies'],
    allowShutdownGaps: options['allow-shutdown-gaps'],
    gapTailMs: options['gap-tail-ms'],
  };

  // --- Stack on FROM -----------------------------------------------------
  log('removing any previous oci-upgrade stack');
  await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5'], env);
  Object.assign(env, {
    OCI_MIGRATE_IMAGE: R.from.api,
    OCI_API1_IMAGE: R.from.api,
    OCI_API2_IMAGE: R.from.api,
    OCI_WEB1_IMAGE: R.from.web,
    OCI_WEB2_IMAGE: R.from.web,
  });
  log('starting postgres, redis and the stub model');
  await must(
    compose(['up', '-d', '--wait', 'postgres', 'redis', 'stub'], env),
    'starting infrastructure',
  );
  log(`migrating with ${fromTag}'s migrate job`);
  await must(
    compose(['--profile', 'tools', 'run', '--rm', 'migrate'], env),
    `${fromTag} migrate job`,
  );
  log(`starting two ${fromTag} API replicas (RUN_MIGRATIONS=false) and two web proxies`);
  await must(compose(['up', '-d', '--no-deps', 'api-1', 'api-2'], env), 'starting FROM api');
  await Promise.all([waitHealthy('api-1', env), waitHealthy('api-2', env)]);
  await must(compose(['up', '-d', '--no-deps', 'web-1', 'web-2'], env), 'starting FROM web');
  await Promise.all(bases.map((b) => waitHttp(`${b}/api/health/ready`)));

  // --- Data ----------------------------------------------------------------
  const people = await setupThroughApi({
    bases,
    origin,
    people: options.people,
    stubUrl: 'http://stub:4181/v1',
    log,
  });
  // Instances require email verification by default and the test has no mail
  // server, so the accounts created above are marked verified directly.
  await psql(
    `update "user" set email_verified = true where email like 'person%@upgrade.test';`,
    env,
  );
  log(
    `seeding ${options.threads} conversations x ${options['messages-per-thread']} messages through SQL`,
  );
  R.seed = {
    people: people.length,
    ...(await seedConversations({
      env,
      threads: options.threads,
      perThread: options['messages-per-thread'],
      log: (m) => console.log(m),
    })),
  };
  log(
    `seeded ${R.seed.messages} messages (${R.seed.messageTableSize}) in ${Math.round(R.seed.totalMs / 1000)} s`,
  );
  R.seed.usage = await seedUsageEvents({
    env,
    total: options['usage-events'],
    log: (m) => console.log(m),
  });
  log(
    R.seed.usage.skipped
      ? `no usage events seeded: ${R.seed.usage.skipped}`
      : `seeded ${R.seed.usage.events} usage events (${R.seed.usage.tableSize}; ${R.seed.usage.fromReplies} for seeded replies, ${R.seed.usage.deletedAccounts} of deleted accounts, ${R.seed.usage.models} models, ${R.seed.usage.pending} unsettled) in ${(R.seed.usage.totalMs / 1000).toFixed(1)} s`,
  );
  const loadPeople = people.slice(0, Math.min(options.vus, people.length - 1));
  const smokePerson = people.at(-1);
  const threadMap = await seededThreadsFor(loadPeople, env);
  const before = await appliedMigrationTimes();

  // TO must be ready before the load starts: building it beside the load
  // would distort the latencies measured.
  const waitedForTo = Date.now();
  const prepared = await preparingTo;
  if (Date.now() - waitedForTo > 1_000)
    log(`waited ${Math.round((Date.now() - waitedForTo) / 1000)} s for the TO images`);
  const { toApi, toWeb, journal: toJournal } = prepared;
  const toApiEffective = prepared.effective;
  R.to = { version: sourceVersion, api: toApi, web: toWeb };
  if (prepared.inject) R.inject = { case: options.inject, ...prepared.inject };
  R.platform.to = await Promise.all([toApi, toWeb].map((i) => localArch(i))).then((archs) =>
    archs.map((a) => `linux/${a}`),
  );

  // --- Load ----------------------------------------------------------------
  const eventsFile = join(outDir, 'events.ndjson');
  writeFileSync(eventsFile, '');
  const loadConfig = {
    eventsFile,
    bases,
    origin,
    vus: options.vus,
    thinkMs: options['think-ms'],
    sendEvery: options['send-every'],
    signInEvery: 25,
    requestTimeoutMs: options['request-timeout-ms'],
    replyTimeoutMs: 120_000,
    password: PERSON_PASSWORD,
    words: WORDS,
    people: loadPeople.map((email) => ({
      email,
      threads: threadMap.get(email) ?? [],
    })),
  };
  const configFile = join(outDir, 'load-config.json');
  writeFileSync(configFile, JSON.stringify(loadConfig, null, 2));
  R.load = {
    vus: options.vus,
    bases,
    thinkMs: options['think-ms'],
    sendEvery: options['send-every'],
  };
  const load = fork(join(TOOL_DIR, 'load.mjs'), [configFile], {
    stdio: 'inherit',
  });
  const loadDone = new Promise((resolveDone) => {
    load.on('message', (m) => m?.type === 'done' && resolveDone(m.counters));
    load.on('exit', () => resolveDone(null));
  });
  /**
   * Waits (up to 30 s) until the stub model is streaming a reply to this
   * replica, at least a second in, so stopping it always catches one.
   */
  const waitForReplyOn = async (id) => {
    const ip = await inspect(id, '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const r = await compose(
        ['exec', '-T', 'stub', 'wget', '-q', '-O', '-', 'http://127.0.0.1:4181/active'],
        env,
      );
      try {
        const streams = JSON.parse(r.stdout);
        if (streams.some((s) => s.ip === ip && Date.now() - s.startedAt > 1000)) return true;
      } catch {}
      await sleep(250);
    }
    return false;
  };
  let phase = 'baseline';
  const setPhase = (name) => {
    phase = name;
    load.send({ type: 'phase', name });
    log(`phase: ${name}`);
  };
  const stopMonitor = startLockMonitor(() => phase);
  setPhase('baseline');
  await sleep(options['baseline-seconds'] * 1000);

  try {
    // --- Pre-deploy migrations under load ---------------------------------
    setPhase('migrate');
    Object.assign(env, { OCI_MIGRATE_IMAGE: toApiEffective });
    const m0 = Date.now();
    const migration = await compose(['--profile', 'tools', 'run', '--rm', 'migrate'], env);
    const after = await appliedMigrationTimes().catch(() => before);
    const newTimes = after.filter((t) => !before.includes(t));
    R.migration = {
      exitCode: migration.code,
      ms: Date.now() - m0,
      applied: toJournal.filter((e) => newTimes.includes(e.when)).map((e) => e.tag),
      output: (migration.stdout + migration.stderr).slice(-4000),
    };
    log(
      `migrate job exit ${migration.code} in ${Math.round(R.migration.ms / 100) / 10} s; applied: ${R.migration.applied.join(', ') || 'none'}`,
    );

    // --- FROM on the new schema --------------------------------------------
    setPhase('smoke-old');
    R.smokeOld = await runSmoke({
      bases,
      origin,
      person: smokePerson,
      label: 'old',
    });
    log(
      `smoke (previous release, new schema): ${R.smokeOld.total - R.smokeOld.failed}/${R.smokeOld.total}`,
    );

    // --- Replace replicas one at a time -------------------------------------
    R.replacements = [];
    // [service, image variable, image, phase, whether the stopped replica drains]
    const targets = [
      ['api-1', 'OCI_API1_IMAGE', toApiEffective, 'replace', fromDrains],
      ['api-2', 'OCI_API2_IMAGE', toApiEffective, 'replace', fromDrains],
      ...(options['replace-web']
        ? [
            ['web-1', 'OCI_WEB1_IMAGE', toWeb, 'replace', null],
            ['web-2', 'OCI_WEB2_IMAGE', toWeb, 'replace', null],
          ]
        : []),
      // The new release replacing itself: every proxy and replica now runs TO.
      ...(options['restart-api']
        ? [
            ['api-1', 'OCI_API1_IMAGE', toApiEffective, 'restart', true],
            ['api-2', 'OCI_API2_IMAGE', toApiEffective, 'restart', true],
          ]
        : []),
    ];
    const postDeploy = async () => {
      // --- Post-deploy phase: every replica now runs TO -------------------
      setPhase('post-deploy');
      const p0 = Date.now();
      const post = await compose(['--profile', 'tools', 'run', '--rm', 'migrate-post'], env);
      R.postDeploy = {
        exitCode: post.code,
        ms: Date.now() - p0,
        steps: await postSteps(),
        scheduled: (await backgroundMigrations()).map((m) => m.name),
        output: (post.stdout + post.stderr).slice(-4000),
      };
      log(
        `migrate --post exit ${post.code} in ${(R.postDeploy.ms / 1000).toFixed(1)} s; steps: ${
          R.postDeploy.steps
            .map(
              (step) => `${step.name} ${step.finished ? `${step.durationMs} ms` : 'NOT FINISHED'}`,
            )
            .join(', ') || 'none'
        }; background migrations scheduled: ${R.postDeploy.scheduled.join(', ') || 'none'}`,
      );
    };
    let postDone = !options['post-deploy'];
    for (const [service, variable, image, kind, drains] of targets) {
      if (kind === 'restart' && !postDone) {
        await postDeploy();
        postDone = true;
      }
      setPhase(`${kind}-${service}`);
      const isWeb = service.startsWith('web');
      const webBase = service === 'web-1' ? bases[0] : bases[1];
      if (isWeb) {
        // The web tier is a stateless proxy behind whatever balances it; take
        // this one out of rotation first, as that balancer would.
        load.send({ type: 'drain', base: webBase });
        await sleep(3000);
      }
      const id = await containerId(service, env);
      const caughtReply = isWeb ? null : await waitForReplyOn(id);
      const stopRequestedAt = Date.now();
      const stopTimeout = service.startsWith('api') ? options['stop-timeout'] : 10;
      await must(compose(['stop', '-t', String(stopTimeout), service], env), `stopping ${service}`);
      const stoppedAt = Date.now();
      const exitCode = Number(await inspect(id, '{{.State.ExitCode}}'));
      env[variable] = image;
      await must(
        compose(['up', '-d', '--no-deps', service], env),
        `starting ${service} on ${image}`,
      );
      if (isWeb) await waitHttp(`${webBase}/api/health/ready`);
      else await waitHealthy(service, env);
      const readyAt = Date.now();
      if (isWeb) load.send({ type: 'undrain', base: webBase });
      R.replacements.push({
        service,
        kind,
        drains,
        image,
        stopRequestedAt,
        stoppedAt,
        exitCode,
        readyAt,
        caughtReply,
      });
      log(
        `${kind} ${service}: SIGTERM -> exited (code ${exitCode}) in ${((stoppedAt - stopRequestedAt) / 1000).toFixed(1)} s; new replica ready ${((readyAt - stoppedAt) / 1000).toFixed(1)} s later`,
      );
      // Let the proxy re-resolve `api` and route to the new replica before the next stop.
      await sleep(options['settle-seconds'] * 1000);
      // Releases before v0.11 read only the previous secret format.
      const fromReadsVersioned =
        STABLE.test(fromTag) && compareVersions(fromTag, FIRST_VERSIONED_SECRETS) >= 0;
      if (kind === 'replace' && service === 'api-1' && !fromReadsVersioned) {
        R.secretsMixed = await secretsDuringUpgrade();
        log(
          `secrets with both releases serving: provider key saved ${R.secretsMixed.saved}/${R.secretsMixed.attempts} times; stored ${R.secretsMixed.legacy} in the previous format, ${R.secretsMixed.versioned} versioned`,
        );
      }
    }

    if (!postDone) await postDeploy();

    // --- Background migrations, under load --------------------------------------
    if (options['post-deploy']) {
      setPhase('background');
      const b0 = Date.now();
      const deadline = b0 + options['background-timeout-seconds'] * 1000;
      let migrations = await backgroundMigrations();
      while (
        migrations.some((m) => !['finished', 'failed', 'paused'].includes(m.status)) &&
        Date.now() < deadline
      ) {
        await sleep(2000);
        migrations = await backgroundMigrations();
      }
      R.background = {
        waitedMs: Date.now() - b0,
        timedOut: migrations.some((m) => !['finished', 'failed', 'paused'].includes(m.status)),
        timeoutMs: options['background-timeout-seconds'] * 1000,
        migrations,
      };
      log(
        `background migrations: ${
          migrations
            .map(
              (m) =>
                `${m.name} ${m.status}, ${m.rowsProcessed} rows in ${m.batches} batches${m.ms === null ? '' : ` over ${(m.ms / 1000).toFixed(1)} s`}`,
            )
            .join('; ') || 'none'
        } (waited ${(R.background.waitedMs / 1000).toFixed(1)} s after the restarts)`,
      );

      // Every stored secret re-encrypted into the versioned format.
      R.secretsAfter = await secretFormats();
      log(
        `secrets after the background migrations: ${R.secretsAfter.versioned} versioned, ${R.secretsAfter.legacy} in the previous format`,
      );

      // The usage-rollup backfill: its batches and duration, then whether the
      // rollups equal the raw events (checked under load, in one snapshot).
      const backfill = migrations.find((m) => m.name === USAGE_ROLLUP_BACKFILL) ?? null;
      const c0 = Date.now();
      const check = await usageRollupCheck();
      if (backfill || check) {
        R.usageRollups = { backfill, check, checkMs: Date.now() - c0 };
        log(
          `usage rollups: backfill ${
            backfill
              ? `${backfill.status}, ${backfill.rowsProcessed} events in ${backfill.batches} batches${backfill.ms === null ? '' : ` over ${(backfill.ms / 1000).toFixed(1)} s`}`
              : 'not scheduled'
          }; ${
            check
              ? `${check.events} events, ${check.personKeys} (hour, person, model) keys, ${check.personDiffering} differing; ${check.modelKeys} (hour, model) keys, ${check.modelDiffering} differing; ${check.unmarked} unmarked, ${check.unfolded} unfolded changes: ${check.exact ? 'EXACT' : 'MISMATCH'}`
              : 'no rollup tables'
          } (checked in ${R.usageRollups.checkMs} ms)`,
        );
      }
    }

    // --- TO --------------------------------------------------------------------
    setPhase('smoke-new');
    R.smokeNew = await runSmoke({
      bases,
      origin,
      person: smokePerson,
      label: 'new',
      requireAll: true,
    });
    log(`smoke (new release): ${R.smokeNew.total - R.smokeNew.failed}/${R.smokeNew.total}`);

    setPhase('cooldown');
    await sleep(options['cooldown-seconds'] * 1000);
  } finally {
    load.send({ type: 'stop' });
    R.loadCounters = await loadDone;
    R.locks = await stopMonitor();
  }

  // --- Report -------------------------------------------------------------------
  await collectLogs(['api-1', 'api-2', 'web-1', 'web-2', 'postgres', 'stub']);
  const lines = readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const replies = lines.filter((l) => l.type === 'reply');
  const events = lines.filter((l) => l.type !== 'reply');
  R.durationMs = Date.now() - startedAt;
  report.verdict = analyse({ events, replies, run: R, bounds: R.bounds });
  writeReports(outDir, report);
  log(`report: ${join(outDir, 'report.md')}`);
  for (const c of report.verdict.criteria) {
    console.log(`  ${c.pass ? 'pass' : c.informational ? 'note' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  console.log(`VERDICT: ${report.verdict.pass ? 'PASS' : 'FAIL'}`);
  return report.verdict.pass;
}

let exitCode = 2;
process.on('SIGINT', async () => {
  log('interrupted; tearing down');
  await teardown();
  process.exit(130);
});
try {
  const pass = await main();
  exitCode = pass === !options['expect-fail'] ? 0 : 1;
  if (options['expect-fail']) {
    console.log(
      pass ? 'Expected a failure (negative control) but the test passed.' : 'Failed as expected.',
    );
  }
} catch (error) {
  console.error(`upgrade-test could not complete: ${error.stack ?? error}`);
  await collectLogs(['api-1', 'api-2', 'web-1', 'web-2', 'postgres']).catch(() => {});
} finally {
  await teardown();
}
process.exit(exitCode);
