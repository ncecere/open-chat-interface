#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone test tool, never a Turbo task.
/**
 * Restore drill (issue #386; docs/dev/restore-drill.md): a pgBackRest
 * point-in-time restore of an OCI database, then the procedure of
 * docs/admin/external-database-backup.md ("The restore drill") against it.
 *
 * 1. PostgreSQL 17 with pgvector and pgBackRest (Dockerfile) archiving WAL to a
 *    local, encrypted repository: `stanza-create`, `check`, one full backup.
 *    OCI built from this checkout runs on it (OCI_ROLE=all) with attachments
 *    and backups on a VersityGW S3 server.
 * 2. OCI's migrations, a provider, a person, conversations and attachments; the
 *    backup setting `databaseBackup: 'external'`; an OCI backup run (R1). More
 *    writes, a recorded target time T, more writes, a second OCI run (R2) and a
 *    WAL segment switch that is waited for until it is archived.
 * 3. The primary and its data volume are removed, and the attachment bucket is
 *    emptied. `pgbackrest restore --type=time --target=T --target-action=promote`
 *    fills a fresh volume; a second PostgreSQL starts on it.
 * 4. OCI starts on the restored database as OCI_ROLE=web, no worker. Attachments
 *    come back with `backup:restore-files` from R1 (the newest run at or before T)
 *    and then R2 (the oldest at or after T).
 * 5. Checks: rows before T present and after T absent; OCI migrates cleanly and
 *    starts; System health shows no error except "no background worker"; a stored
 *    credential decrypts (the same ENCRYPTION_KEY); the storage check reports a
 *    record without an object after R1 alone (the attachment RPO) and none after
 *    R2; every restored attachment downloads with the SHA-256 of its
 *    attachments.jsonl line; a conversation with an attachment opens; the web
 *    process wrote nothing to the backup bucket. It prints the restore times.
 *
 * Exit codes: 0 pass, 1 a check failed, 2 the drill itself could not run.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMIN,
  PERSON_PASSWORD,
  parseArgs,
  personEmail,
  readUiStream,
  run,
  sleep,
} from '../upgrade-test/lib.mjs';
import { setupThroughApi } from '../upgrade-test/seed.mjs';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIR, '../..');
const PROJECT = 'oci-restore';
const COMPOSE_FILE = join(TOOL_DIR, 'compose.yaml');
const MODEL = 'upgrade-stub';

// Throwaway test values, the same as compose.yaml's.
const S3 = { accessKeyId: 'restore_drill_s3', secret: 'restore-drill-only-s3-secret' };
const SOURCE_DB = 'postgres://oci:restore-drill-only@pg:5432/oci';
const RESTORED_DB = 'postgres://oci:restore-drill-only@pg-restored:5432/oci';
const ATTACHMENTS = 'oci-attachments';
const BACKUPS = 'oci-backups';
const BACKUP_PREFIX = 'oci-backups/';
const NOT_VERIFIED = 'Not verified by OCI: that a base backup exists, is recent, or restores.';

const spec = {
  'api-image': { default: '' },
  out: {
    default: resolve(TOOL_DIR, 'out', new Date().toISOString().replace(/[:.]/g, '-')),
  },
  port: { type: 'number', default: 18781 },
  'port-restored': { type: 'number', default: 18782 },
  /** Size of each attachment, in KiB. */
  'file-kib': { type: 'number', default: 96 },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};
const options = parseArgs(process.argv.slice(2), spec);
if (options.help) {
  console.log(
    `Usage: node tools/restore-drill/run.mjs [options]\n\n${Object.entries(spec)
      .map(([k, v]) => `  --${k}${v.type === 'boolean' ? '' : ' <value>'}  (default: ${v.default})`)
      .join('\n')}`,
  );
  process.exit(0);
}

const outDir = resolve(options.out);
mkdirSync(outDir, { recursive: true });
const base = `http://127.0.0.1:${options.port}`;
const baseRestored = `http://127.0.0.1:${options['port-restored']}`;
const env = {
  OCI_DRILL_PORT: String(options.port),
  OCI_DRILL_PORT_RESTORED: String(options['port-restored']),
};
const timeline = [];
const startedAt = Date.now();
function log(what) {
  const at = new Date().toISOString();
  timeline.push({ at, what });
  console.log(`[restore-drill ${at.slice(11, 19)}] ${what}`);
}

const R = { options, startedAt: new Date(startedAt).toISOString(), times: {}, checks: [] };
const check = (name, pass, detail) => R.checks.push({ name, pass: Boolean(pass), detail });
const seconds = (ms) => Math.round(ms / 100) / 10;

/* ------------------------------------------------------------------------ */

function compose(args, { input, extraEnv } = {}) {
  return run(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '-f',
      COMPOSE_FILE,
      '--profile',
      'restored',
      '--profile',
      'tools',
      ...args,
    ],
    { env: { ...env, ...extraEnv }, input, cwd: TOOL_DIR },
  );
}

async function must(promise, what) {
  const result = await promise;
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result;
}

async function waitFor(what, probe, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

/** SQL as the application role, in the source (`pg`) or the restored (`pg-restored`) server. */
async function psql(sql, service = 'pg') {
  const result = await must(
    compose(
      [
        'exec',
        '-T',
        service,
        'psql',
        '-U',
        'oci',
        '-d',
        'oci',
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-F',
        '\t',
      ],
      { input: sql },
    ),
    `psql on ${service}`,
  );
  return result.stdout.trim();
}

/** pgBackRest in the source server, as the postgres user. */
function pgbackrest(args) {
  return compose(['exec', '-T', '-u', 'postgres', 'pg', 'pgbackrest', '--stanza=oci', ...args]);
}

/** A one-off job in the API image, against the restored database unless `database` says otherwise. */
function tool(args, { database = RESTORED_DB, extraEnv = [] } = {}) {
  const flags = ['-e', `DATABASE_URL=${database}`, ...extraEnv.flatMap((e) => ['-e', e])];
  return compose(['run', '--rm', '-T', ...flags, 'tool', ...args]);
}

async function s3tool(...args) {
  const result = await must(tool(['s3tool.mjs', ...args]), `s3tool ${args[0]}`);
  return result.stdout.trim();
}
const s3json = async (...args) => JSON.parse(await s3tool(...args));

/** The S3 helper's output for one bucket, as a stable string to compare. */
async function bucketState(bucket) {
  const objects = await s3json('list', bucket);
  return JSON.stringify(objects.sort((a, b) => a.key.localeCompare(b.key)));
}

/** A signed-in client of one OCI instance (`as`), for people and for the administrator. */
async function session(root, email, password) {
  const response = await fetch(`${root}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: root },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(`Sign-in for ${email} failed: HTTP ${response.status}`);
  const cookie = (response.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ');
  return async (method, path, body, { stream = false } = {}) => {
    const headers = { cookie, origin: root };
    if (body !== undefined && !(body instanceof FormData))
      headers['content-type'] = 'application/json';
    const reply = await fetch(root + path, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (stream) return { status: reply.status, response: reply };
    const bytes = Buffer.from(await reply.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    if (/^\s*[{[]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {}
    }
    return { status: reply.status, json, text, bytes };
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function buildApiImage() {
  const image = 'oci-restore-api:drill';
  const revision = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim() || 'unknown';
  log(`building ${image} from this checkout (${revision.slice(0, 8)})`);
  const t0 = Date.now();
  await must(
    run(
      'docker',
      [
        'build',
        '-q',
        '-f',
        'docker/api.Dockerfile',
        '--build-arg',
        `OCI_REVISION=${revision}`,
        '-t',
        image,
        '.',
      ],
      { cwd: REPO_ROOT },
    ),
    `building ${image}`,
  );
  log(`built ${image} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return image;
}

/** Switches the WAL segment and waits until pgBackRest has archived it. */
async function archiveCurrentWal() {
  const segment = await psql('select pg_walfile_name(pg_switch_wal())');
  await waitFor(
    `WAL segment ${segment} archived`,
    async () =>
      (await psql(
        `select coalesce(last_archived_wal >= '${segment}', false) from pg_stat_archiver`,
      )) === 't',
    90_000,
    500,
  );
  return segment;
}

/** Waits for the newest backup run to finish; returns it. */
async function waitForRun(as, previousId) {
  return waitFor(
    'the backup run to finish',
    async () => {
      const status = await as('GET', '/api/admin/backups');
      const latest = status.json?.runs?.[0];
      if (!latest || latest.id === previousId) return null;
      if (latest.status === 'failed') throw new Error(`Backup run failed: ${latest.errorMessage}`);
      return latest.status === 'succeeded' ? latest : null;
    },
    180_000,
    1000,
  );
}

async function startBackup(as) {
  const before = (await as('GET', '/api/admin/backups')).json?.runs?.[0]?.id ?? null;
  const started = await as('POST', '/api/admin/backups/run');
  if (started.status !== 202)
    throw new Error(`Back up now answered ${started.status}: ${started.text}`);
  return waitForRun(as, before);
}

function textFile(kib) {
  return Buffer.from(
    randomBytes(kib * 1024)
      .toString('base64')
      .replace(/(.{76})/g, '$1\n'),
  );
}

async function uploadFile(as, label, kib = options['file-kib']) {
  const bytes = textFile(kib);
  const form = new FormData();
  form.append('files', new File([bytes], `${label}.txt`, { type: 'text/plain' }));
  const reply = await as('POST', '/api/attachments', form);
  if (reply.status !== 201)
    throw new Error(`Uploading ${label} failed: ${reply.status} ${reply.text}`);
  const id = reply.json.attachments[0].id;
  const key = await psql(`select storage_key from attachment where id = '${id}'`);
  return { label, id, key, sha256: sha256(bytes), size: bytes.length };
}

async function createThread(as, title) {
  const reply = await as('POST', '/api/threads', { title });
  if (reply.status !== 201)
    throw new Error(`Creating "${title}" failed: ${reply.status} ${reply.text}`);
  return reply.json.thread.id;
}

/** Sends one message with an attachment to the stub model and reads the reply to its end. */
async function sendWithAttachment(as, threadId, attachmentId) {
  const sent = await as(
    'POST',
    '/api/chat',
    {
      threadId,
      modelSlug: MODEL,
      attachmentIds: [attachmentId],
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: 'Restore drill: summarise the file.' }],
        },
      ],
    },
    { stream: true },
  );
  if (sent.status !== 200)
    throw new Error(
      `Sending the message answered ${sent.status}: ${(await sent.response.text()).slice(0, 400)}`,
    );
  const read = await readUiStream(sent.response, { timeoutMs: 60_000 });
  if (!read.complete) throw new Error(`The reply did not finish: ${JSON.stringify(read)}`);
}

/* ------------------------------------------------------------------------ */

async function main() {
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (docker.code !== 0) throw new Error('Docker is not available');
  const apiImage = options['api-image'] || (await buildApiImage());
  env.OCI_DRILL_API_IMAGE = apiImage;
  R.images = { api: apiImage };

  // --- The primary with pgBackRest ------------------------------------------
  log('removing any previous oci-restore stack');
  await compose(['down', '-v', '--remove-orphans', '--timeout', '5']);
  log('building the PostgreSQL 17 + pgvector + pgBackRest image');
  await must(compose(['build', 'pg']), 'building the PostgreSQL image');
  log('starting PostgreSQL, Redis, the S3 server and the stub model');
  await must(
    compose(['up', '-d', '--wait', '--wait-timeout', '180', 'pg', 'redis', 's3', 'stub']),
    'starting the stack',
  );
  R.pgbackrestVersion = (
    await must(
      compose(['exec', '-T', '-u', 'postgres', 'pg', 'pgbackrest', 'version']),
      'pgbackrest version',
    )
  ).stdout.trim();
  log(`PostgreSQL is up; ${R.pgbackrestVersion}`);
  await waitFor('the S3 server', async () => (await s3tool('ping')) === 'ok', 60_000);
  await s3tool('mkbucket', ATTACHMENTS);
  await s3tool('mkbucket', BACKUPS);

  await must(pgbackrest(['stanza-create']), 'stanza-create');
  await must(pgbackrest(['check']), 'pgbackrest check');
  const t0 = Date.now();
  await must(pgbackrest(['--type=full', 'backup']), 'the full backup');
  R.times.baseBackupSeconds = seconds(Date.now() - t0);
  log(`full backup of the empty database took ${R.times.baseBackupSeconds} s`);

  // --- OCI on it ------------------------------------------------------------
  await must(tool(['dist/migrate.js'], { database: SOURCE_DB }), 'migrating the source database');
  await must(compose(['up', '-d', '--wait', '--wait-timeout', '180', 'api']), 'starting OCI');
  await setupThroughApi({
    bases: [base],
    origin: base,
    people: 1,
    stubUrl: 'http://stub:4181/v1',
    log,
  });
  await psql(`update "user" set email_verified = true where email like 'person%@upgrade.test';`);
  const admin = await session(base, ADMIN.email, ADMIN.password);
  const person = await session(base, personEmail(1), PERSON_PASSWORD);

  const storage = await admin('PATCH', '/api/admin/settings', {
    storage: {
      driver: 's3',
      s3: {
        bucket: ATTACHMENTS,
        region: 'us-east-1',
        endpoint: 'http://s3:7070',
        accessKeyId: S3.accessKeyId,
        forcePathStyle: true,
        secretAccessKey: S3.secret,
      },
    },
  });
  if (storage.status !== 200)
    throw new Error(`Saving storage settings: ${storage.status} ${storage.text}`);
  const configured = await admin('PATCH', '/api/admin/backups/settings', {
    databaseBackup: 'external',
    destination: 'separate',
    prefix: BACKUP_PREFIX,
    s3: {
      bucket: BACKUPS,
      region: 'us-east-1',
      endpoint: 'http://s3:7070',
      accessKeyId: S3.accessKeyId,
      forcePathStyle: true,
      secretAccessKey: S3.secret,
    },
    copyFiles: true,
    verifyFiles: 'all',
    keepDaily: 7,
    keepWeekly: 0,
    hourUtc: new Date().getUTCHours(),
  });
  if (configured.status !== 200)
    throw new Error(`Saving backup settings: ${configured.status} ${configured.text}`);
  log('OCI configured: attachments and backups on S3, databaseBackup external');

  // --- Data before the first OCI run ------------------------------------------
  const expected = { before: [], between: [], after: [] };
  const files = {};
  // A1 is sent to the stub model, so it is small enough for its input budget.
  files.A1 = await uploadFile(person, 'A1', 4);
  files.A2 = await uploadFile(person, 'A2');
  files.A3 = await uploadFile(person, 'A3');
  for (let n = 1; n <= 3; n++) {
    const title = `drill before-run ${n}`;
    await createThread(person, title);
    expected.before.push(title);
  }
  // A conversation that carries an attachment. Its title is not checked: the
  // first reply may rename it.
  files.A1.thread = await createThread(person, 'restore-drill conversation with a file');
  await sendWithAttachment(person, files.A1.thread, files.A1.id);

  // --- R1 ---------------------------------------------------------------------
  log('OCI backup run R1 (external)');
  const r1 = await startBackup(admin);
  // Retention keeps the newest run of each UTC day, and OCI runs once a day,
  // so R1 and R2 are normally a day apart; a drill cannot wait a day. R1 is
  // aged by one day in backup_run (its objects and manifest are untouched), or
  // R2's retention would delete R1.
  await psql(
    `update backup_run set started_at = started_at - interval '1 day', finished_at = finished_at - interval '1 day' where id = '${r1.id}'`,
  );
  // The restored database will carry "on", with a slot nothing has covered
  // today: a worker would back up at once. The source's own scheduler ticks
  // every 10 minutes from its start, which this drill finishes well inside.
  const enabled = await admin('PATCH', '/api/admin/backups/settings', { enabled: true });
  if (enabled.status !== 200)
    throw new Error(`Turning backups on: ${enabled.status} ${enabled.text}`);
  log(`R1 finished: ${r1.attachmentCount} attachment objects, ${r1.files?.copiedObjects} copied`);

  // --- Between R1 and T -------------------------------------------------------
  files.B1 = await uploadFile(person, 'B1');
  for (let n = 1; n <= 2; n++) {
    const title = `drill between-run-and-T ${n}`;
    await createThread(person, title);
    expected.between.push(title);
  }
  await sleep(2000);
  const [targetText, targetMs] = (
    await psql(`with t as (select clock_timestamp() as t)
       select to_char(t at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00',
              (extract(epoch from t) * 1000)::bigint from t`)
  ).split('\t');
  R.target = { text: targetText, ms: Number(targetMs) };
  log(`target time T = ${targetText}`);
  await sleep(2000);

  // --- After T ----------------------------------------------------------------
  files.C1 = await uploadFile(person, 'C1');
  for (let n = 1; n <= 2; n++) {
    const title = `drill after-T ${n}`;
    await createThread(person, title);
    expected.after.push(title);
  }
  log('OCI backup run R2 (external)');
  const r2 = await startBackup(admin);
  const segment = await archiveCurrentWal();
  log(`R2 finished; WAL segment ${segment} archived`);

  // Attempts before `stanza-create` failed and were retried: that is expected.
  // What matters is that the archiver is not failing now.
  const archiver = await psql(
    `select (last_failed_time is null or last_failed_time <= last_archived_time), failed_count, archived_count from pg_stat_archiver`,
  );
  const [archiverOk, failedCount, archivedCount] = archiver.split('\t');
  const info = JSON.parse(
    (await must(pgbackrest(['--output=json', 'info']), 'pgbackrest info')).stdout,
  );
  const stanza = info.find((s) => s.name === 'oci');
  const fullBackup = stanza?.backup?.[0];
  check(
    'pgBackRest',
    stanza?.status?.code === 0 &&
      stanza.backup?.length === 1 &&
      fullBackup.type === 'full' &&
      archiverOk === 't' &&
      Number(fullBackup.timestamp.stop) * 1000 < R.target.ms,
    `stanza ok (${stanza?.status?.message}); one ${fullBackup?.type} backup taken before T; WAL archive ${stanza?.archive?.[0]?.min}..${stanza?.archive?.[0]?.max}; the archiver is not failing (${failedCount} early attempts failed before stanza-create, ${archivedCount} segments archived)`,
  );

  // The OCI runs, from the backup bucket as a disaster would leave it.
  const sourceRuns = await s3json('runs', BACKUPS, BACKUP_PREFIX);
  const backupObjects = await s3json('list', BACKUPS);
  check(
    'external runs',
    r1.dumpKey === null &&
      r1.dumpBytes === null &&
      r2.dumpKey === null &&
      sourceRuns.length === 2 &&
      sourceRuns.every((r) => r.database?.external === true && r.filesCopied) &&
      !backupObjects.some((o) => /database\.dump$/.test(o.key)) &&
      r1.files?.copiedObjects === 3 &&
      r2.files?.copiedObjects === 2 &&
      r2.files?.skippedObjects === 3 &&
      /backed up outside OCI/.test(r2.verificationDetail ?? ''),
    `2 runs, manifests say database.external; no database.dump object in the bucket; R1 copied ${r1.files?.copiedObjects}, R2 copied ${r2.files?.copiedObjects} and skipped ${r2.files?.skippedObjects}; "${r2.verificationDetail}"`,
  );
  const sourceHealth = (await admin('GET', '/api/admin/health')).json;
  const sourceRow = sourceHealth?.checks?.find((c) => c.id === 'database-backup');
  check(
    'System health row (source)',
    sourceRow?.status === 'ok' && sourceRow.detail.includes(NOT_VERIFIED),
    `${sourceRow?.label}: ${sourceRow?.status}: ${sourceRow?.detail}`,
  );
  const sourceThreads = Number(
    await psql(`select count(*) from thread where title like 'drill %'`),
  );
  if (sourceThreads !== 7)
    throw new Error(`Expected 7 drill conversations in the source, found ${sourceThreads}`);

  // --- The disaster -----------------------------------------------------------
  log(
    'removing the primary, its data volume and the attachment bucket; the repository and the backup bucket stay',
  );
  await must(compose(['stop', '--timeout', '30', 'api', 'pg']), 'stopping the source');
  await must(compose(['rm', '-f', '-v', 'api', 'pg']), 'removing the source');
  await must(run('docker', ['volume', 'rm', `${PROJECT}_pgdata`]), 'removing the data volume');
  await s3tool('wipe', ATTACHMENTS);
  await compose(['exec', '-T', 'redis', 'redis-cli', 'flushall']);
  const backupBucketBefore = await bucketState(BACKUPS);

  // --- Restore the database to T ----------------------------------------------
  log(`pgbackrest restore --type=time --target="${R.target.text}" --target-action=promote`);
  const restoreStart = Date.now();
  await must(
    compose([
      'run',
      '--rm',
      '-T',
      'restore',
      '--stanza=oci',
      '--process-max=2',
      '--type=time',
      `--target=${R.target.text}`,
      '--target-action=promote',
      '--archive-mode=off',
      'restore',
    ]),
    'pgbackrest restore',
  );
  const restoreCommandMs = Date.now() - restoreStart;
  R.times.restoreCommandSeconds = seconds(restoreCommandMs);
  log(`pgbackrest restore took ${R.times.restoreCommandSeconds} s`);
  await must(compose(['up', '-d', 'pg-restored']), 'starting the restored PostgreSQL');
  await waitFor(
    'the restored PostgreSQL to finish recovery and promote',
    async () => (await psql('select pg_is_in_recovery()', 'pg-restored')) === 'f',
    300_000,
    500,
  );
  R.times.workingDatabaseSeconds = seconds(Date.now() - restoreStart);
  R.times.recoverySeconds = seconds(Date.now() - restoreStart - restoreCommandMs);
  log(`a working database ${R.times.workingDatabaseSeconds} s after the restore began`);
  const recoveryLog = (await compose(['logs', '--no-log-prefix', 'pg-restored'])).stdout
    .split('\n')
    .filter((line) =>
      /recovery stopping|last completed transaction|selected new timeline|archive recovery complete|starting point-in-time/i.test(
        line,
      ),
    )
    .map((line) => line.replace(/^\S+\s+/, '').slice(0, 240));
  R.recoveryLog = recoveryLog;

  // Rows before T present, after T absent.
  const titles = (
    await psql(`select title from thread where title like 'drill %' order by title`, 'pg-restored')
  )
    .split('\n')
    .filter(Boolean);
  const wantTitles = [...expected.before, ...expected.between].sort();
  const attachmentsAtT = (
    await psql(`select storage_key from attachment order by storage_key`, 'pg-restored')
  )
    .split('\n')
    .filter(Boolean);
  const wantKeys = ['A1', 'A2', 'A3', 'B1'].map((l) => files[l].key).sort();
  const runRows = await psql(
    `select count(*), count(*) filter (where dump_key is null and dump_bytes is null and dump_sha256 is null and status = 'succeeded') from backup_run`,
    'pg-restored',
  );
  const archiveMode = await psql('show archive_mode', 'pg-restored');
  check(
    'rows at T',
    JSON.stringify(titles) === JSON.stringify(wantTitles) &&
      JSON.stringify(attachmentsAtT) === JSON.stringify(wantKeys) &&
      runRows === '1\t1',
    `conversations before T present (${titles.length} of ${wantTitles.length}), after T absent (${expected.after.length} written); attachment records A1 A2 A3 B1 present, C1 absent (${attachmentsAtT.length}); backup_run has R1 only, with no dump columns (${runRows.replace('\t', ' of ')} external); recovery: ${recoveryLog.join(' | ') || 'no recovery log lines'}`,
  );
  check(
    'scratch restore does not archive',
    archiveMode === 'off',
    `archive_mode on the restored server: ${archiveMode} (--archive-mode=off)`,
  );

  // --- OCI on the restored database, as OCI_ROLE=web --------------------------
  const preflight = await tool(['dist/scripts/upgrade-check.js']);
  const migrate = await tool(['dist/migrate.js']);
  check(
    'upgrade preflight and migrations',
    preflight.code === 0 && migrate.code === 0,
    `upgrade-check exit ${preflight.code}: ${preflight.stdout.split('\n').find((l) => /No migration|nothing|current|up to date|rolling/i.test(l)) ?? preflight.stdout.trim().split('\n')[0]}; migrate exit ${migrate.code}`,
  );
  await must(
    compose(['up', '-d', '--wait', '--wait-timeout', '180', 'api-restored']),
    'starting OCI on the restored database',
  );
  const adminR = await session(baseRestored, ADMIN.email, ADMIN.password);
  const personR = await session(baseRestored, personEmail(1), PERSON_PASSWORD);
  const health = (await adminR('GET', '/api/admin/health')).json;
  const errors = (health?.checks ?? []).filter((c) => c.status === 'error' && c.id !== 'workers');
  const workers = (health?.checks ?? []).find((c) => c.id === 'workers');
  const restoredRow = (health?.checks ?? []).find((c) => c.id === 'database-backup');
  check(
    'OCI starts as OCI_ROLE=web and System health has no error but "no worker"',
    health &&
      errors.length === 0 &&
      workers?.status === 'error' &&
      restoredRow?.detail?.includes(NOT_VERIFIED),
    `${health?.checks?.length} rows; errors besides workers: ${errors.map((e) => `${e.label}: ${e.detail}`).join('; ') || 'none'}; Background workers: ${workers?.status}; ${restoredRow?.label}: ${restoredRow?.status} (${restoredRow?.detail?.slice(0, 90)}...)`,
  );

  // ENCRYPTION_KEY: a stored provider credential decrypts.
  const providers = (await adminR('GET', '/api/admin/providers')).json;
  const providerId = (providers?.providers ?? providers)?.[0]?.id;
  const discovered = await adminR('POST', `/api/admin/providers/${providerId}/discover`);
  check(
    'stored credentials decrypt (ENCRYPTION_KEY)',
    discovered.status === 200 && (discovered.json?.models ?? []).length > 0,
    `provider discovery with the stored, encrypted key: HTTP ${discovered.status}, ${(discovered.json?.models ?? []).length} model(s)`,
  );

  // --- Attachments: the newest run at or before T, then the oldest at or after ---
  const runs = await s3json('runs', BACKUPS, BACKUP_PREFIX);
  const atOrBefore = runs.filter((r) => Date.parse(r.createdAt) <= R.target.ms).at(-1);
  const atOrAfter = runs.find((r) => Date.parse(r.createdAt) >= R.target.ms);
  if (!atOrBefore || !atOrAfter) throw new Error('Could not choose the OCI runs around T');
  const folderUrl = (run) => `s3://${BACKUPS}/${run.folder}`;
  const restoreFiles = (run, ...flags) =>
    tool(['dist/scripts/restore-backup-files.js', folderUrl(run), '--to-s3', ...flags], {
      extraEnv: [`BACKUP_S3_BUCKET=${BACKUPS}`, `TARGET_S3_BUCKET=${ATTACHMENTS}`],
    });
  const parse = (out) => {
    const m =
      /(Would restore|Restored) (\d+) of (\d+) files \((\d+) bytes\); (\d+) already present; (\d+) listed as missing when the backup was made; (\d+) failed/.exec(
        out,
      );
    return m
      ? { restored: +m[2], objects: +m[3], present: +m[5], missing: +m[6], failed: +m[7] }
      : null;
  };

  const attachmentsStart = Date.now();
  const dry = await restoreFiles(atOrBefore, '--dry-run');
  const dryResult = parse(dry.stdout);
  const emptyNow = (await s3json('list', ATTACHMENTS)).length;
  const first = await restoreFiles(atOrBefore);
  const firstResult = parse(first.stdout);
  const reconcileOne = (await adminR('POST', '/api/admin/lifecycle/storage-reconcile')).json;
  const second = await restoreFiles(atOrAfter);
  const secondResult = parse(second.stdout);
  const reconcileTwo = (await adminR('POST', '/api/admin/lifecycle/storage-reconcile')).json;
  R.times.attachmentsSeconds = seconds(Date.now() - attachmentsStart);
  log(
    `attachments: both runs restored in ${R.times.attachmentsSeconds} s (each call includes starting a container)`,
  );
  R.reconcile = { afterRunBeforeT: reconcileOne, afterBothRuns: reconcileTwo };

  check(
    'runs chosen around T',
    atOrBefore.folder !== atOrAfter.folder &&
      atOrBefore.folder === sourceRuns[0].folder &&
      atOrAfter.folder === sourceRuns[1].folder,
    `newest at or before T: ${atOrBefore.folder} (${atOrBefore.createdAt}); oldest at or after T: ${atOrAfter.folder} (${atOrAfter.createdAt})`,
  );
  check(
    'backup:restore-files',
    dry.code === 0 &&
      dryResult?.restored === 3 &&
      emptyNow === 0 &&
      first.code === 0 &&
      firstResult?.restored === 3 &&
      firstResult.failed === 0 &&
      second.code === 0 &&
      secondResult?.restored === 2 &&
      secondResult.present === 3 &&
      secondResult.failed === 0,
    `dry run on the emptied bucket: would restore ${dryResult?.restored} of ${dryResult?.objects}; run before T: ${first.stdout.trim()}; run after T: ${second.stdout.trim()}`,
  );
  check(
    'attachment RPO and Check for orphans',
    reconcileOne?.missingObjects === 1 &&
      reconcileTwo?.missingObjects === 0 &&
      reconcileTwo?.queuedForDeletion === 0,
    `records with no object: ${reconcileOne?.missingObjects} after the run before T alone (B1, uploaded after that run), ${reconcileTwo?.missingObjects} after the run after T too; objects with no record: ${reconcileTwo?.orphanedObjects} (C1's copy is one, but objects under 24 hours are never counted)`,
  );

  // Downloads equal the attachments.jsonl lines (and what was uploaded).
  const jsonl = (await s3tool('get', BACKUPS, `${atOrAfter.folder}attachments.jsonl`))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byKey = new Map(jsonl.map((line) => [line.key, line.sha256]));
  const problems = [];
  for (const label of ['A1', 'A2', 'A3', 'B1']) {
    const file = files[label];
    const download = await personR('GET', `/api/attachments/${file.id}/content`);
    const got = download.status === 200 ? sha256(download.bytes) : `HTTP ${download.status}`;
    if (got !== byKey.get(file.key) || got !== file.sha256) problems.push(`${label}: ${got}`);
  }
  check(
    'attachment downloads',
    problems.length === 0,
    problems.length
      ? `mismatches: ${problems.join('; ')}`
      : `A1, A2, A3 and B1 download with the SHA-256 of their attachments.jsonl line and of what was uploaded`,
  );
  const messages = await personR('GET', `/api/chat/${files.A1.thread}/messages`);
  check(
    'conversation with an attachment opens',
    messages.status === 200 && messages.text.includes(files.A1.id),
    `GET messages of the conversation that carried A1: HTTP ${messages.status}, the attachment ${messages.text.includes(files.A1.id) ? 'is' : 'is NOT'} referenced`,
  );

  // The web role changed nothing at the backup destination.
  const backupBucketAfter = await bucketState(BACKUPS);
  const runsAfter = await psql('select count(*) from backup_run', 'pg-restored');
  const runningAfter = await psql(
    `select count(*) from backup_run where status = 'running'`,
    'pg-restored',
  );
  check(
    'no worker, nothing written to the backup bucket',
    backupBucketAfter === backupBucketBefore && runsAfter === '1' && runningAfter === '0',
    `the backup bucket is unchanged (${JSON.parse(backupBucketAfter).length} objects) and backup_run still has ${runsAfter} run, though the restored database says backups are on`,
  );
}

/* ------------------------------------------------------------------------ */

let exitCode = 0;
try {
  await main();
  exitCode = R.checks.every((c) => c.pass) ? 0 : 1;
} catch (error) {
  log(`the drill could not run: ${error instanceof Error ? error.message : String(error)}`);
  R.error = error instanceof Error ? error.message : String(error);
  exitCode = 2;
  const logs = await compose([
    'logs',
    '--no-color',
    '--tail',
    '60',
    'pg',
    'pg-restored',
    'api',
    'api-restored',
  ]).catch(() => null);
  if (logs) writeFileSync(join(outDir, 'service-logs.txt'), logs.stdout);
} finally {
  R.timeline = timeline;
  R.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(R, null, 2));
  const lines = [
    `# Restore drill (pgBackRest): ${exitCode === 0 ? 'PASS' : exitCode === 1 ? 'FAIL' : 'ERROR'}`,
    '',
    R.pgbackrestVersion
      ? `${R.pgbackrestVersion}, PostgreSQL 17, target time T = ${R.target?.text ?? 'not reached'}`
      : '',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...R.checks.map(
      (c) =>
        `| ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${String(c.detail).replaceAll('|', '\\|')} |`,
    ),
    '',
    '| Time | Seconds |',
    '| --- | --- |',
    `| Full backup (empty database) | ${R.times.baseBackupSeconds ?? 'n/a'} |`,
    `| pgbackrest restore (into a fresh volume) | ${R.times.restoreCommandSeconds ?? 'n/a'} |`,
    `| Recovery to T and promotion | ${R.times.recoverySeconds ?? 'n/a'} |`,
    `| **Time to a working database** (restore began to primary) | ${R.times.workingDatabaseSeconds ?? 'n/a'} |`,
    `| Attachments (dry run, R1, R2 and two Check for orphans) | ${R.times.attachmentsSeconds ?? 'n/a'} |`,
    `| Whole drill | ${R.durationSeconds} |`,
    '',
    R.error ? `Error: ${R.error}` : '',
  ];
  writeFileSync(join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}\n\nReport: ${join(outDir, 'report.md')}`);
  if (!options.keep) {
    log('removing the stack');
    await compose(['down', '-v', '--remove-orphans', '--timeout', '10']);
  }
}
process.exit(exitCode);
