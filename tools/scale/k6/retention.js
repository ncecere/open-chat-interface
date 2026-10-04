/**
 * Retention phase: an administrator runs usage-event and audit-log retention
 * (each prunes about the oldest quarter, as run.sh sets the windows) while
 * people keep browsing, so the report shows how long pruning takes and what
 * it does to everyone else's latency. Destructive, so it runs last.
 */

import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { PROFILES } from '../profiles.mjs';
import {
  browseOnce,
  digest,
  ensureSignedIn,
  fixtures,
  forThisVu,
  params,
  think,
  trendStats,
} from './lib.js';

const PROFILE = PROFILES[__ENV.SCALE_PROFILE || 'tiny'];
const load = PROFILE.load;

const during = {
  errors: new Rate('retention_errors'),
  sidebar: new Trend('sidebar_during_retention_ms', true),
  sidebarThreads: new Trend('sidebar_threads_during_retention_ms', true),
  conversationOpen: new Trend('conversation_open_during_retention_ms', true),
  conversationMessages: new Trend('conversation_messages_during_retention'),
};
const retentionJob = new Trend('retention_job_ms', true);
const retentionItems = new Counter('retention_items');

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-vus',
      exec: 'browse',
      vus: Math.max(2, Math.ceil(load.vus.browse / 2)),
      duration: `${load.retentionSeconds}s`,
      gracefulStop: '30s',
    },
    retention: {
      executor: 'shared-iterations',
      exec: 'retention',
      vus: 1,
      iterations: 1,
      startTime: '5s',
      maxDuration: '60m',
    },
  },
  thresholds: {
    'retention_job_ms{job:usage-events}': ['max>=0'],
    'retention_job_ms{job:audit-log}': ['max>=0'],
    'retention_items{job:usage-events}': ['count>=0'],
    'retention_items{job:audit-log}': ['count>=0'],
  },
  summaryTrendStats: trendStats(),
  noCookiesReset: true,
};

export function browse() {
  browseOnce(forThisVu(fixtures.browse), during);
  think(1, 3);
}

export function retention() {
  if (!ensureSignedIn(fixtures.admin.email)) return;
  for (const [name, label] of [
    ['retention.usage-events', 'usage-events'],
    ['retention.audit-log', 'audit-log'],
  ]) {
    const started = Date.now();
    const res = http.post(
      `${__ENV.SCALE_BASE_URL || 'http://web:8080'}/api/admin/lifecycle/jobs/${name}/run`,
      '{}',
      params(`job-${label}`, { timeout: '3600s' }),
    );
    if (res.status !== 200) {
      during.errors.add(true);
      continue;
    }
    retentionJob.add(Date.now() - started, { job: label });
    retentionItems.add(res.json('itemsProcessed') || 0, { job: label });
  }
}

export function handleSummary(data) {
  return {
    [__ENV.SCALE_SUMMARY || '/results/k6-retention.json']: JSON.stringify(data, null, 2),
    stdout: digest(data, [
      'retention_job_ms',
      'retention_items',
      'sidebar_during_retention_ms',
      'conversation_open_during_retention_ms',
      'retention_errors',
    ]),
  };
}
