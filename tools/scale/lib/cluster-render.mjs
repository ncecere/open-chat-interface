// Fills the ${VARIABLES} of tools/scale/k8s/*.yaml. Values are restricted to a character set that
// cannot break out of a YAML scalar or a shell word, and an unfilled variable is an error, as
// dev-env's own templates (homelab tools/dev-env/devenv/common.py render()).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const K8S_DIR = join(dirname(fileURLToPath(import.meta.url)), '../k8s');

export const TEMPLATES = [
  'environment-configmap.yaml',
  'harness-secret.yaml',
  'run-job.yaml',
  'stub.yaml',
  'tools-configmap.yaml',
];

/**
 * Every variable the templates use, with an example value (tests, validate.sh and `--dry-run`).
 * Real values come from cluster.sh.
 */
export const EXAMPLE_VARS = {
  ENV: 'scale-t1',
  API_IMAGE: 'ghcr.io/ncecere/open-chat-interface/api:dev-0123456789ab',
  K6_IMAGE: 'grafana/k6:1.3.0',
  LOAD_NODE: 'talos-cp-1',
  PROFILE: 'tiny',
  SEED: 'oci-scale',
  DIMENSIONS: '1536',
  GENERATE_WORKERS: '2',
  NOW_DATE: '2026-10-14',
  DEADLINE_SECONDS: '5400',
  APP_URL: 'http://localhost:18123',
  WAIT_BACKFILL: 'false',
  BACKFILL_WAIT_SECONDS: '14400',
  SKIP_RETENTION: 'false',
  API_REPLICAS: '1',
  STUB_FIRST_TOKEN_MS: '500',
  STUB_TOKENS_PER_SECOND: '50',
  STUB_REPLY_TOKENS: '250',
  COMMIT: 'abcdef012345',
  METRICS_TOKEN: 'example-metrics-token-0001',
  TOOLS_TGZ_B64: 'H4sIAAAAAAAAA+3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA3AXhFwiMAKAAA',
  ENVIRONMENT_JSON_B64: 'e30=',
};

const SAFE_VALUE = /^[A-Za-z0-9._:/@,+=-]+$/;

export function renderTemplate(name, vars) {
  if (!TEMPLATES.includes(name)) throw new Error(`Unknown template ${name}`);
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in EXAMPLE_VARS)) throw new Error(`Unknown variable ${key}`);
    if (typeof value !== 'string' || value === '') throw new Error(`Variable ${key} is empty`);
    if (!SAFE_VALUE.test(value))
      throw new Error(
        `Variable ${key} has an unsafe value (allowed: letters, digits and . _ : / @ , + = -)`,
      );
  }
  let text = readFileSync(join(K8S_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`\${${key}}`, value);
  const left = [...new Set(text.match(/\$\{[A-Z_0-9]+\}/g) ?? [])];
  if (left.length > 0)
    throw new Error(`Template ${name} has unfilled variables: ${left.join(', ')}`);
  return text;
}
