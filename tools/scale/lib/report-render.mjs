import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROFILES, TARGETS } from '../profiles.mjs';
import { readJson, runDir, writeJson } from './report-context.mjs';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function metric(summary, name) {
  const m = summary?.metrics?.[name];
  if (!m) return null;
  return m.values;
}

const fmtMs = (v) =>
  v === undefined || v === null ? '–' : `${Math.round(v).toLocaleString('en-US')}`;
const fmtInt = (v) => (v === undefined || v === null ? '–' : Math.round(v).toLocaleString('en-US'));
const fmtGiB = (b) => `${(b / 1024 ** 3).toFixed(2)} GiB`;
const fmtMiB = (b) => (b >= 1024 ** 3 ? fmtGiB(b) : `${(b / 1024 ** 2).toFixed(0)} MiB`);
const pct = (v) => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(2)}%`);

const SCENARIO_ROWS = [
  ['Sign-in storm (one sign-in)', 'signin_ms', 'signin'],
  ['Sidebar (parallel requests)', 'sidebar_ms', 'browse'],
  ['Sidebar: conversation list request', 'sidebar_threads_ms', 'browse'],
  ['Open a conversation', 'conversation_open_ms', 'browse'],
  ['Reply start added by OCI (chat)', 'chat_pre_model_ms', 'chat'],
  ['  … history under 20k characters', 'chat_pre_model_ms{prompt:short}', 'chat'],
  ['  … history 20k–150k characters', 'chat_pre_model_ms{prompt:medium}', 'chat'],
  ['  … history over 150k characters', 'chat_pre_model_ms{prompt:long}', 'chat'],
  ['Reply start added by OCI (project chat)', 'project_pre_model_ms', 'project'],
  ['  … large project: passages searched', 'project_pre_model_ms{files:searched}', 'project'],
  ['  … small project: files included whole', 'project_pre_model_ms{files:whole}', 'project'],
  ['Chat: time to first byte', 'chat_ttfb_ms', 'chat'],
  ['Chat: whole reply (stub streams ~5 s)', 'chat_total_ms', 'chat'],
  ['Chat: relay after the last token', 'chat_tail_ms', 'chat'],
  ['Project chat: whole reply', 'project_total_ms', 'project'],
  ['Keyword search (all terms)', 'search_ms', 'search'],
  ['Keyword search: common word', 'search_ms{bucket:common}', 'search'],
  ['Keyword search: medium word', 'search_ms{bucket:medium}', 'search'],
  ['Keyword search: rare word', 'search_ms{bucket:rare}', 'search'],
  ['Keyword search: two words', 'search_ms{bucket:phrase}', 'search'],
  ['Admin pages (all)', 'admin_ms', 'admin'],
];
const ADMIN_PAGES = [
  'overview',
  'usage-overview',
  'usage-spend',
  'usage-limits',
  'usage-storage',
  'users',
  'audit',
  'health',
];

function scenarioRows(main) {
  const rows = [];
  const all = [
    ...SCENARIO_ROWS,
    ...ADMIN_PAGES.map((page) => [`Admin: ${page}`, `admin_ms{page:${page}}`, 'admin']),
  ];
  for (const [label, name, scenario] of all) {
    const v = metric(main, name);
    if (!v || !v.count) continue;
    const target = TARGETS[name] ?? null;
    const errors = metric(main, `errors{scenario:${scenario}}`);
    rows.push({
      label,
      metric: name,
      scenario,
      p50: v.med,
      p95: v['p(95)'],
      p99: v['p(99)'],
      max: v.max,
      count: v.count,
      target,
      met: target === null ? null : v['p(95)'] < target,
      errorRate: errors?.rate ?? null,
    });
  }
  return rows;
}

function jobRows(main, before, after, steadySeconds) {
  const out = [];
  for (const [job, label, unit, key] of [
    ['index', 'projects.index-files', 'files', 'indexed_files'],
    ['embed', 'projects.embed-passages', 'passages', 'embeddings'],
  ]) {
    const timing = metric(main, `job_ms{job:${job}}`);
    const items = metric(main, `job_items{job:${job}}`);
    if (!timing) continue;
    const busySeconds = (timing.avg * timing.count) / 1000;
    out.push({
      job: label,
      unit,
      runs: timing.count,
      items: items?.count ?? 0,
      p50Ms: timing.med,
      p95Ms: timing['p(95)'],
      itemsPerBusySecond: busySeconds > 0 ? (items?.count ?? 0) / busySeconds : null,
      itemsPerMinute: steadySeconds > 0 ? ((items?.count ?? 0) * 60) / steadySeconds : null,
      backlogDelta: before && after ? after[key] - before[key] : null,
    });
  }
  return out;
}

export function render() {
  const generate = readJson('generate.json');
  const main = readJson('k6-main.json');
  const retention = readJson('k6-retention.json');
  const dbMain = readJson('db-main.json');
  const dbRetention = readJson('db-retention.json');
  const before = readJson('backlog-before.json');
  const after = dbMain?.backlog ?? null;
  const env = process.env;
  const profileName = generate?.profile ?? env.SCALE_PROFILE ?? 'tiny';
  const profile = PROFILES[profileName];
  const scenarios = scenarioRows(main);
  const jobs = jobRows(main, before, after, profile?.load.steadySeconds ?? 0);
  const retentionJobs = ['usage-events', 'audit-log'].map((job) => ({
    job: `retention.${job}`,
    ms: metric(retention, `retention_job_ms{job:${job}}`)?.max ?? null,
    items: metric(retention, `retention_items{job:${job}}`)?.count ?? null,
  }));
  const during = {
    sidebarP95: metric(retention, 'sidebar_during_retention_ms')?.['p(95)'] ?? null,
    conversationP95: metric(retention, 'conversation_open_during_retention_ms')?.['p(95)'] ?? null,
    errors: metric(retention, 'retention_errors')?.rate ?? null,
  };
  const report = {
    profile: profileName,
    date: env.SCALE_DATE ?? new Date().toISOString().slice(0, 10),
    commit: env.SCALE_COMMIT ?? null,
    hardware: {
      cpu: env.SCALE_HW_CPU ?? null,
      memory: env.SCALE_HW_MEMORY ?? null,
      dockerCpus: env.SCALE_DOCKER_CPUS ?? null,
      dockerMemory: env.SCALE_DOCKER_MEMORY ?? null,
      os: env.SCALE_HW_OS ?? null,
    },
    setup: {
      apiReplicas: Number(env.SCALE_API_REPLICAS ?? 1),
      stub: {
        firstTokenMs: Number(env.STUB_FIRST_TOKEN_MS ?? 500),
        tokensPerSecond: Number(env.STUB_TOKENS_PER_SECOND ?? 50),
        replyTokens: Number(env.STUB_REPLY_TOKENS ?? 250),
      },
      load: profile?.load ?? null,
    },
    dataset: generate
      ? {
          counts: generate.counts,
          seconds: generate.totalSeconds,
          loadSeconds: generate.loadSeconds,
          rowsPerSecondLoad: generate.rowsPerSecondLoad,
          rowsPerSecondOverall: generate.rowsPerSecondOverall,
          messagesPerSecondLoad: generate.messagesPerSecondLoad,
          databaseBytes: generate.database.bytes,
          timings: generate.timings,
          slowestIndexes: generate.indexTimings.slice(0, 5),
          dimensions: generate.dimensions,
        }
      : null,
    targets: TARGETS,
    scenarios,
    jobs,
    retention: { jobs: retentionJobs, during, backlog: dbRetention?.backlog ?? null },
    database: dbMain
      ? {
          bytes: dbMain.databaseBytes,
          tables: dbMain.tables,
          indexes: dbMain.indexes,
          named: dbMain.named,
          vectorProbe: dbMain.vectorProbe,
          statements: dbMain.statements,
          jobRuns: dbMain.jobs,
        }
      : null,
    replicaMetrics: dbMain?.metrics ?? null,
    k6Thresholds: main
      ? Object.fromEntries(
          Object.entries(main.metrics)
            .filter(([, m]) => m.thresholds)
            .map(([name, m]) => [name, Object.values(m.thresholds).every((t) => t.ok)]),
        )
      : null,
  };
  writeJson('report.json', report);
  writeFileSync(resolve(runDir, 'report.md'), markdown(report));
  console.log('Wrote report.json and report.md');
}

function markdown(r) {
  const lines = [];
  const push = (...l) => lines.push(...l);
  push(`# Scale harness results: \`${r.profile}\`, ${r.date}`, '');
  push(
    `Commit \`${r.commit ?? 'unknown'}\`; ${r.setup.apiReplicas} API replica(s) behind the web proxy; stub model: first token after ${r.setup.stub.firstTokenMs} ms, ${r.setup.stub.tokensPerSecond} tokens/s, ${r.setup.stub.replyTokens} tokens a reply.`,
    '',
  );
  push(
    `Hardware: ${r.hardware.cpu ?? 'unknown CPU'}, ${r.hardware.memory ?? '?'} memory${r.hardware.os ? `, ${r.hardware.os}` : ''}; Docker: ${r.hardware.dockerCpus ?? '?'} CPUs, ${r.hardware.dockerMemory ?? '?'} memory. Everything (PostgreSQL, Redis, API, web, stub, k6) shares that machine.`,
    '',
  );
  if (r.setup.load) {
    const v = r.setup.load.vus;
    push(
      `Load: sign-in storm at ${r.setup.load.signinRate}/s for ${r.setup.load.signinHoldSeconds} s (after a ${r.setup.load.signinRampSeconds} s ramp), then ${r.setup.load.steadySeconds} s of mixed load with ${v.browse} browsing, ${v.chat} chatting, ${v.search} searching, ${v.project} project-chatting, ${v.admin} admin and ${v.jobs} job-running virtual users, each a signed-in person with think time.`,
      '',
    );
  }
  if (r.dataset) {
    const c = r.dataset.counts;
    push('## Dataset', '');
    push('| Table | Rows |', '| --- | ---: |');
    for (const [table, count] of Object.entries(c)) push(`| ${table} | ${fmtInt(count)} |`);
    push('');
    push(
      `Generated in ${r.dataset.seconds.toFixed(0)} s (COPY phase ${r.dataset.loadSeconds.toFixed(0)} s at ${fmtInt(r.dataset.rowsPerSecondLoad)} rows/s, ${fmtInt(r.dataset.messagesPerSecondLoad)} messages/s; ${fmtInt(r.dataset.rowsPerSecondOverall)} rows/s including derived tables, index rebuilds and VACUUM). Database after generation: ${fmtGiB(r.dataset.databaseBytes)}. Embeddings: ${r.dataset.dimensions} dimensions.`,
      '',
    );
  }
  push('## Latency by scenario (ms)', '');
  push(
    '| Scenario | p50 | p95 | p99 | n | Target (p95) | Met | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: |',
  );
  for (const s of r.scenarios) {
    push(
      `| ${s.label} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} | ${fmtInt(s.count)} | ${s.target === null ? '' : `< ${s.target}`} | ${s.met === null ? '' : s.met ? 'yes' : '**no**'} | ${pct(s.errorRate)} |`,
    );
  }
  push(
    '',
    '"Reply start added by OCI" is the time from sending the message to the stub model receiving the request: everything OCI does before the model is asked. The stub\'s own first-token delay is excluded; the relay of tokens back is measured separately ("relay after the last token").',
    '',
  );
  if (r.jobs.length > 0) {
    push('## Background jobs under load', '');
    push(
      '| Job | Runs | Items | p50 run (ms) | p95 run (ms) | Items per busy second | Items per minute |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const j of r.jobs) {
      push(
        `| ${j.job} (${j.unit}) | ${fmtInt(j.runs)} | ${fmtInt(j.items)} | ${fmtMs(j.p50Ms)} | ${fmtMs(j.p95Ms)} | ${j.itemsPerBusySecond === null ? '–' : j.itemsPerBusySecond.toFixed(1)} | ${j.itemsPerMinute === null ? '–' : j.itemsPerMinute.toFixed(0)} |`,
      );
    }
    push('');
  }
  if (r.retention.jobs.some((j) => j.ms !== null)) {
    push('## Retention under load', '');
    push('| Job | Duration (ms) | Rows deleted |', '| --- | ---: | ---: |');
    for (const j of r.retention.jobs) push(`| ${j.job} | ${fmtMs(j.ms)} | ${fmtInt(j.items)} |`);
    push(
      '',
      `While they ran: sidebar p95 ${fmtMs(r.retention.during.sidebarP95)} ms, conversation opening p95 ${fmtMs(r.retention.during.conversationP95)} ms, errors ${pct(r.retention.during.errors)}.`,
      '',
    );
  }
  if (r.database) {
    push('## Database', '');
    push(`Size after the main run: ${fmtGiB(r.database.bytes)}.`, '');
    push(
      '| Table | Rows | Total | Table | Indexes | Dead tuples |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const t of r.database.tables.slice(0, 12)) {
      push(
        `| ${t.name} | ${fmtInt(t.rows)} | ${fmtMiB(t.totalBytes)} | ${fmtMiB(t.tableBytes)} | ${fmtMiB(t.indexBytes)} | ${Math.max(t.rows, t.live) + t.dead > 0 ? pct(t.dead / (Math.max(t.rows, t.live) + t.dead)) : '–'} |`,
      );
    }
    push('', '| Largest indexes | Table | Size | Scans |', '| --- | --- | ---: | ---: |');
    for (const i of r.database.indexes.slice(0, 10)) {
      push(`| ${i.name} | ${i.table} | ${fmtMiB(i.bytes)} | ${fmtInt(i.scans)} |`);
    }
    push('');
    if (r.database.named) {
      push('### Named queries (pg_stat_statements, main run)', '');
      push('| Query | Calls | Mean (ms) | Max (ms) |', '| --- | ---: | ---: | ---: |');
      for (const q of r.database.named) {
        if (q.calls === 0) continue;
        push(`| ${q.label} | ${fmtInt(q.calls)} | ${q.meanMs.toFixed(2)} | ${fmtInt(q.maxMs)} |`);
      }
      push('');
    }
    if (r.database.vectorProbe) {
      const v = r.database.vectorProbe;
      push('### pgvector exact scans (EXPLAIN ANALYZE after the main run)', '');
      push(
        '| Scope | Passages scanned | Files | Median (ms) | Max (ms) |',
        '| --- | ---: | ---: | ---: | ---: |',
      );
      v.projects.forEach((p, index) => {
        push(
          `| Project with the ${index === 0 ? 'most' : `#${index + 1} most`} passages | ${fmtInt(p.passages)} | ${fmtInt(p.files)} | ${p.medianMs?.toFixed(1) ?? '–'} | ${Number.isFinite(p.maxMs) ? p.maxMs.toFixed(1) : '–'} |`,
        );
      });
      push(
        `| Every embedding, no project filter (top 10) | ${fmtInt(v.global.embeddings)} | | ${v.global.medianMs?.toFixed(1) ?? '–'} | |`,
        '',
      );
    }
    if (r.database.statements) {
      push('### Top queries by total time (pg_stat_statements, main run)', '');
      push(
        '| # | Calls | Total (ms) | Mean (ms) | Max (ms) | Query |',
        '| ---: | ---: | ---: | ---: | ---: | --- |',
      );
      r.database.statements.slice(0, 12).forEach((s, index) => {
        const query = s.query.replace(/\|/g, '\\|').slice(0, 220);
        push(
          `| ${index + 1} | ${fmtInt(s.calls)} | ${fmtInt(s.totalMs)} | ${s.meanMs.toFixed(1)} | ${fmtInt(s.maxMs)} | \`${query}\` |`,
        );
      });
      push('');
    }
  }
  if (r.replicaMetrics?.requestsPerReplica?.length > 1) {
    push(
      `Requests handled per API replica (since each started): ${r.replicaMetrics.requestsPerReplica.map(fmtInt).join(', ')}.`,
      '',
    );
  }
  if (r.replicaMetrics?.routes?.length) {
    push('### Slowest API routes by total time (OCI metrics, all replicas)', '');
    push('| Route | Requests | Mean (ms) |', '| --- | ---: | ---: |');
    for (const route of r.replicaMetrics.routes.slice(0, 10)) {
      push(`| \`${route.route}\` | ${fmtInt(route.count)} | ${route.meanMs.toFixed(1)} |`);
    }
    push('');
  }
  return `${lines.join('\n')}\n`;
}
