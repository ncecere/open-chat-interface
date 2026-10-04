/**
 * Turns the load's events, the smoke results and the runner's timeline into a
 * verdict, `report.json` and `report.md`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latencyStats } from './lib.mjs';

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export function analyse({ events, replies, run, bounds }) {
  // Windows in which an API replica was stopping or had just been killed:
  // SIGTERM until gapTailMs after it exited (the proxy re-resolves `api` every
  // 10 s and retries a dead address for up to 5 s).
  const windows = (run.replacements ?? [])
    .filter((r) => r.service.startsWith('api'))
    .map((r) => [r.stopRequestedAt, r.stoppedAt + bounds.gapTailMs]);
  const inGap = (at) => windows.some(([from, to]) => at >= from && at <= to);
  const gapEvents = bounds.allowShutdownGaps ? events.filter((e) => inGap(e.at)) : [];
  const requests = bounds.allowShutdownGaps ? events.filter((e) => !inGap(e.at)) : events;
  const gapFailures = gapEvents.filter((e) => e.outcome === 'fail');
  const gapLatency = latencyStats(gapEvents.map((e) => e.ttfb));
  const failures = requests.filter((e) => e.outcome === 'fail');
  const serverErrors = failures.filter((e) => e.status >= 500);
  const networkErrors = failures.filter((e) => e.status === 0);
  const unexpected = failures.filter((e) => e.status > 0 && e.status < 500);
  const retried = requests.filter((e) => e.retried);
  const failovers = requests.reduce((sum, e) => sum + (e.failovers ?? 0), 0);

  const phases = [...new Set(events.map((e) => e.phase))];
  const byPhase = phases.map((phase) => {
    const list = events.filter((e) => e.phase === phase);
    return {
      phase,
      requests: list.length,
      failed: list.filter((e) => e.outcome === 'fail').length,
      retried: list.filter((e) => e.retried).length,
      ...latencyStats(list.map((e) => e.ttfb)),
    };
  });
  const names = [...new Set(events.map((e) => e.name))].sort();
  const byName = names.map((name) => {
    const list = events.filter((e) => e.name === name);
    return {
      name,
      requests: list.length,
      failed: list.filter((e) => e.outcome === 'fail').length,
      ...latencyStats(list.map((e) => e.ttfb)),
    };
  });
  const overall = latencyStats(requests.map((e) => e.ttfb));
  const slowest = [...events]
    .sort((a, b) => b.ttfb - a.ttfb)
    .slice(0, 10)
    .map(({ at, phase, name, status, ttfb, error }) => ({
      at: new Date(at).toISOString(),
      phase,
      name,
      status,
      ttfb,
      error,
    }));

  const replyCounts = { total: replies.length, complete: 0, resumed: 0, cut: 0, error: 0 };
  for (const r of replies) replyCounts[r.outcome] = (replyCounts[r.outcome] ?? 0) + 1;

  // Replies in flight while each replica was stopping.
  const replacements = (run.replacements ?? []).map((rep) => {
    const overlapping = replies.filter(
      (r) => r.startedAt < rep.stoppedAt && (r.streamEndedAt ?? r.endedAt) > rep.stopRequestedAt,
    );
    const outcomes = {};
    for (const r of overlapping) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const requestsDuring = events.filter(
      (e) => e.at >= rep.stopRequestedAt && e.at <= rep.readyAt,
    ).length;
    return { ...rep, repliesInFlight: overlapping.length, outcomes, requestsDuring };
  });

  const criteria = [];
  const add = (name, pass, detail, { informational = false } = {}) =>
    criteria.push({ name, pass, detail, informational });

  add(
    'migration job succeeded',
    run.migration?.exitCode === 0,
    run.migration ? `exit ${run.migration.exitCode} in ${fmt(run.migration.ms)}` : 'not run',
  );
  const scope = bounds.allowShutdownGaps ? ' outside replica-shutdown windows' : '';
  add(
    `no server errors (5xx)${scope}`,
    serverErrors.length === 0,
    `${serverErrors.length} of ${requests.length} requests`,
  );
  add(
    'no network errors or timeouts',
    networkErrors.length === 0,
    `${networkErrors.length} (after one retry of idempotent requests; ${retried.length} retried, ${failovers} refused connections moved to the other web replica)`,
  );
  add('no unexpected refusals (4xx)', unexpected.length === 0, `${unexpected.length}`);
  add(
    `p99 time to headers < ${fmt(bounds.p99Ms)}${scope}`,
    overall.p99 < bounds.p99Ms,
    `p99 ${fmt(overall.p99)}`,
  );
  add(
    `max time to headers < ${fmt(bounds.maxMs)}${scope}`,
    overall.max < bounds.maxMs,
    `max ${fmt(overall.max)}`,
  );
  add(
    `no application query waits on a lock > ${fmt(bounds.lockWaitMs)}`,
    (run.locks?.maxWaitMs ?? 0) < bounds.lockWaitMs,
    `longest observed wait ${fmt(run.locks?.maxWaitMs ?? 0)} (sampled every ${run.locks?.intervalMs ?? '?'} ms)`,
  );
  add(
    'previous-release smoke suite passes on the new schema',
    run.smokeOld?.passed === true,
    run.smokeOld
      ? `${run.smokeOld.total - run.smokeOld.failed}/${run.smokeOld.total}${run.smokeOld.skipped ? ` (${run.smokeOld.skipped} not in this release)` : ''}`
      : 'not run',
  );
  add(
    'new-release smoke suite passes',
    run.smokeNew?.passed === true,
    run.smokeNew ? `${run.smokeNew.total - run.smokeNew.failed}/${run.smokeNew.total}` : 'not run',
  );
  const strictReplyErrors = replies.filter(
    (r) => r.outcome === 'error' && !(bounds.allowShutdownGaps && inGap(r.endedAt)),
  ).length;
  add(
    'no replies ended in an error',
    strictReplyErrors === 0,
    `${strictReplyErrors} of ${replyCounts.total}`,
  );
  if (bounds.allowShutdownGaps) {
    add(
      'while an API replica was stopping (known gap, design item 13: reported, allowed)',
      true,
      `${gapEvents.length} requests, ${gapFailures.length} failed (${summarise(gapFailures)}), p99 ${fmt(gapLatency.p99)}, max ${fmt(gapLatency.max)}`,
      { informational: true },
    );
  }
  add(
    bounds.allowCutReplies
      ? 'replies cut off by a replica stopping (known gap, design item 13: allowed)'
      : 'no replies cut off by a replica stopping',
    bounds.allowCutReplies || replyCounts.cut === 0,
    `${replyCounts.cut} cut, ${replyCounts.resumed} resumed, ${replyCounts.complete} complete`,
    { informational: bounds.allowCutReplies },
  );
  add(
    'load was running in every phase',
    byPhase.every((p) => p.requests > 0),
    byPhase.map((p) => `${p.phase} ${p.requests}`).join(', '),
  );
  add(
    'replies were in flight during API replica replacement',
    replacements.filter((r) => r.service.startsWith('api')).some((r) => r.repliesInFlight > 0),
    replacements.map((r) => `${r.service} ${r.repliesInFlight}`).join(', '),
    { informational: true },
  );

  const pass = criteria.every((c) => c.pass || c.informational);
  return {
    pass,
    criteria,
    overall,
    byPhase,
    byName,
    slowest,
    failures: failures
      .slice(0, 50)
      .map(({ at, phase, name, method, status, error, detail, ttfb }) => ({
        at: new Date(at).toISOString(),
        phase,
        name,
        method,
        status,
        error,
        detail,
        ttfb,
      })),
    failureCount: failures.length,
    shutdownGap: bounds.allowShutdownGaps
      ? {
          windows: windows.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]),
          requests: gapEvents.length,
          failed: gapFailures.length,
          latency: gapLatency,
          failures: gapFailures.slice(0, 30).map(({ at, phase, name, status, error, ttfb }) => ({
            at: new Date(at).toISOString(),
            phase,
            name,
            status,
            error,
            ttfb,
          })),
        }
      : null,
    retried: retried.length,
    retriedSamples: retried.slice(0, 20).map(({ at, phase, name, retried: why, outcome }) => ({
      at: new Date(at).toISOString(),
      phase,
      name,
      why,
      outcome,
    })),
    failovers,
    replies: replyCounts,
    cutReplies: replies
      .filter((r) => r.outcome !== 'complete')
      .slice(0, 20)
      .map((r) => ({
        phase: r.phase,
        outcome: r.outcome,
        startedAt: new Date(r.startedAt).toISOString(),
        streamError: r.streamError,
        resumed: r.resumed,
        storedStatus: r.storedStatus,
      })),
    replacements,
  };
}

function summarise(list) {
  const counts = {};
  for (const e of list) {
    const key = `${e.name} ${e.status || e.error}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return (
    Object.entries(counts)
      .map(([k, v]) => `${v}x ${k}`)
      .join(', ') || 'none'
  );
}

export function writeReports(outDir, report) {
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), markdown(report));
}

function markdown(report) {
  const { run, verdict } = report;
  const lines = [];
  lines.push(`# Rolling-upgrade test: ${verdict.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`- From: \`${run.from.api}\` (${run.from.version})`);
  lines.push(
    `- To: \`${run.to.api}\`${run.inject ? ` **with injected negative control \`${run.inject.case}\`**: ${run.inject.summary}` : ''}`,
  );
  lines.push(`- Started ${run.startedAt}, took ${fmt(run.durationMs)}`);
  lines.push(
    `- Dataset: ${run.seed?.people} people, ${run.seed?.threads} conversations, ${run.seed?.messages} messages (message table ${run.seed?.messageTableSize}); seeded in ${fmt(run.seed?.totalMs ?? 0)}`,
  );
  lines.push(
    `- Load: ${run.load.vus} virtual users through ${run.load.bases.length} web replicas; ${verdict.overall.count} requests`,
  );
  lines.push(
    `- Migrations applied by the new release: ${run.migration?.applied?.join(', ') || 'none'} (${fmt(run.migration?.ms ?? 0)})`,
  );
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push('| Check | Result | Detail |');
  lines.push('| --- | --- | --- |');
  for (const c of verdict.criteria) {
    lines.push(
      `| ${c.name} | ${c.pass ? 'pass' : c.informational ? 'reported' : '**FAIL**'} | ${c.detail} |`,
    );
  }
  lines.push('');
  lines.push('## Latency by phase (time to response headers)');
  lines.push('');
  lines.push('All requests, including those in replica-shutdown windows.');
  lines.push('');
  lines.push('| Phase | Requests | Failed | Retried | p50 | p95 | p99 | max |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const p of verdict.byPhase) {
    lines.push(
      `| ${p.phase} | ${p.requests} | ${p.failed} | ${p.retried} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.max)} |`,
    );
  }
  lines.push('');
  lines.push('## Latency by request');
  lines.push('');
  lines.push('| Request | Count | Failed | p50 | p95 | p99 | max |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const p of verdict.byName) {
    lines.push(
      `| ${p.name} | ${p.requests} | ${p.failed} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.max)} |`,
    );
  }
  lines.push('');
  lines.push('## Replica replacement');
  lines.push('');
  lines.push(
    '| Replica | Stopped mid-reply | Stop (SIGTERM) took | Exit code | Ready after | Replies in flight | Their outcomes |',
  );
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const r of verdict.replacements) {
    lines.push(
      `| ${r.service} | ${r.caughtReply === null || r.caughtReply === undefined ? 'n/a' : r.caughtReply ? 'yes' : 'no'} | ${fmt(r.stoppedAt - r.stopRequestedAt)} | ${r.exitCode} | ${fmt(r.readyAt - r.stoppedAt)} | ${r.repliesInFlight} | ${JSON.stringify(r.outcomes)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Replies: ${verdict.replies.total} total, ${verdict.replies.complete} complete, ${verdict.replies.resumed} resumed after a cut, ${verdict.replies.cut} cut, ${verdict.replies.error} error.`,
  );
  lines.push('');
  if (run.locks?.top?.length) {
    lines.push('## Longest lock waits observed');
    lines.push('');
    lines.push('| Waited | Phase | Waiting query | Blocked by |');
    lines.push('| ---: | --- | --- | --- |');
    for (const l of run.locks.top) {
      lines.push(`| ${fmt(l.waitedMs)} | ${l.phase} | \`${l.query}\` | \`${l.blocker ?? ''}\` |`);
    }
    lines.push('');
  }
  if (verdict.failureCount) {
    lines.push(`## Failed requests (${verdict.failureCount}, first 50)`);
    lines.push('');
    lines.push('| Time | Phase | Request | Status | Error | Detail |');
    lines.push('| --- | --- | --- | ---: | --- | --- |');
    for (const f of verdict.failures) {
      lines.push(
        `| ${f.at} | ${f.phase} | ${f.name} | ${f.status} | ${f.error ?? ''} | ${(f.detail ?? '').replaceAll('|', '\\|').slice(0, 120)} |`,
      );
    }
    lines.push('');
  }
  if (verdict.shutdownGap?.failed) {
    lines.push(
      `## Failures while an API replica was stopping (${verdict.shutdownGap.failed}; known gap, design item 13)`,
    );
    lines.push('');
    lines.push('| Time | Phase | Request | Status | Error | Time to headers |');
    lines.push('| --- | --- | --- | ---: | --- | ---: |');
    for (const f of verdict.shutdownGap.failures) {
      lines.push(
        `| ${f.at} | ${f.phase} | ${f.name} | ${f.status} | ${f.error ?? ''} | ${fmt(f.ttfb)} |`,
      );
    }
    lines.push('');
  }
  for (const [title, smoke] of [
    ['Smoke: previous release on the new schema', run.smokeOld],
    ['Smoke: new release', run.smokeNew],
  ]) {
    if (!smoke) continue;
    lines.push(
      `## ${title}: ${smoke.passed ? 'pass' : 'FAIL'} (${smoke.total - smoke.failed}/${smoke.total})`,
    );
    lines.push('');
    const failed = smoke.steps.filter((s) => !s.ok);
    for (const s of smoke.steps.filter((x) => x.skipped)) lines.push(`- ${s.name}: ${s.detail}`);
    if (failed.length) {
      for (const s of failed)
        lines.push(`- **${s.name}**: ${String(s.detail).replaceAll('\n', ' ').slice(0, 300)}`);
    } else {
      lines.push(`All steps passed: ${smoke.steps.map((s) => s.name).join(', ')}.`);
    }
    lines.push('');
  }
  lines.push('## Timeline');
  lines.push('');
  for (const t of run.timeline) lines.push(`- ${t.at} ${t.what}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
