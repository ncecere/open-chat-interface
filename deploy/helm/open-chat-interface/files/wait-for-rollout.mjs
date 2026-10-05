// Runs in the post-install/post-upgrade hook before `migrate --post`, from the
// API image (Node, no kubectl). Post-deploy steps may drop what the previous
// release reads, so they wait until every API and worker pod runs this
// release: each Deployment's rollout is complete (as `kubectl rollout status`
// decides) and no pod of it is still terminating (a draining pod of the
// previous release still writes replies). Reads Deployments and lists Pods
// with a token projected into this container only.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = '/var/run/secrets/oci-rollout';
const token = readFileSync(`${dir}/token`, 'utf8').trim();
const ca = readFileSync(`${dir}/ca.crt`);
const namespace = readFileSync(`${dir}/namespace`, 'utf8').trim();
const env = process.env;
const host = env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const port = env.KUBERNETES_SERVICE_PORT || '443';
const names = (env.OCI_ROLLOUT_DEPLOYMENTS || '').split(',').filter(Boolean);
const timeoutMs = Number(env.OCI_ROLLOUT_TIMEOUT_SECONDS || '1800') * 1000;

function get(path) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: host.includes(':') ? `[${host}]` : host,
        port,
        path,
        ca,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 10_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            const error = new Error(`GET ${path}: ${res.statusCode} ${body.slice(0, 200)}`);
            // Missing permissions or objects do not fix themselves.
            error.fatal = [401, 403, 404].includes(res.statusCode);
            reject(error);
            return;
          }
          resolve(JSON.parse(body));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`GET ${path}: timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** Why a Deployment is not done yet, or null when it is. */
async function pending(name) {
  const d = await get(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  const s = d.status ?? {};
  const stalled = (s.conditions ?? []).find(
    (c) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded',
  );
  if (stalled) throw Object.assign(new Error(`${name}: ${stalled.message}`), { fatal: true });
  const want = d.spec.replicas ?? 1;
  const updated = s.updatedReplicas ?? 0;
  if ((s.observedGeneration ?? 0) < d.metadata.generation) return 'rollout not started';
  if (updated < want) return `${updated} of ${want} replicas updated`;
  if ((s.replicas ?? 0) > updated) return `${s.replicas - updated} old replicas pending`;
  if ((s.availableReplicas ?? 0) < updated)
    return `${s.availableReplicas ?? 0} of ${updated} available`;
  const selector = Object.entries(d.spec.selector.matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  const pods = await get(
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`,
  );
  const terminating = pods.items.filter((pod) => pod.metadata.deletionTimestamp).length;
  if (terminating > 0) return `${terminating} pods still terminating`;
  return null;
}

const started = Date.now();
let last = '';
for (;;) {
  let reasons;
  try {
    reasons = (await Promise.all(names.map(async (name) => [name, await pending(name)]))).filter(
      ([, reason]) => reason,
    );
  } catch (error) {
    if (error.fatal) {
      console.error(`Cannot wait for the rollout: ${error.message}`);
      process.exit(1);
    }
    reasons = [['kubernetes', error.message]];
  }
  if (reasons.length === 0) {
    console.log(`Every pod of ${names.join(', ')} runs this release`);
    process.exit(0);
  }
  const summary = reasons.map(([name, reason]) => `${name}: ${reason}`).join('; ');
  if (summary !== last) console.log(`Waiting for the rollout (${summary})`);
  last = summary;
  if (Date.now() - started > timeoutMs) {
    console.error(`Rollout did not finish within ${timeoutMs / 1000} s (${summary})`);
    process.exit(1);
  }
  await sleep(2000);
}
