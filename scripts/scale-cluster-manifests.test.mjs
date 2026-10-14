// The manifests in tools/scale/k8s: rendered with example values, every object must carry the
// environment label (so `dev-env down` and the reaper find it), stay in dev-oci, and meet Pod
// Security `restricted`, which the dev-oci namespace enforces. Resource values are the spec's
// starting values. No cluster is involved; tools/scale/k8s/validate.sh adds a kubeconform pass.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkManifests, ScopeError } from '../tools/scale/lib/cluster-guard.mjs';
import { EXAMPLE_VARS, renderTemplate, TEMPLATES } from '../tools/scale/lib/cluster-render.mjs';
import { parseYaml } from '../tools/scale/lib/cluster-yaml.mjs';

const K8S = join(dirname(fileURLToPath(import.meta.url)), '../tools/scale/k8s');
const ENV = EXAMPLE_VARS.ENV;

const rendered = (name, vars = {}) => parseYaml(renderTemplate(name, { ...EXAMPLE_VARS, ...vars }));
const everything = () =>
  TEMPLATES.flatMap((name) => rendered(name).map((object) => ({ name, object })));

// --- The YAML subset used by the templates ---------------------------------------------------

test('the parser reads the subset the templates use', () => {
  const text = [
    '# comment',
    'a: 1',
    'b: "two # not a comment"',
    "c: 'it''s'",
    'd: true # trailing comment',
    'e: []',
    'f: {}',
    'g: ["x", y, 3]',
    'h:',
    '  - name: first',
    '    value: "1"',
    '  - name: second',
    '    nested:',
    '      k: v',
    'i:',
    '- plain',
    '- 7',
    'script: |',
    '  set -eu',
    '  echo "# kept"',
    '',
    '  tail',
    'strip: |-',
    '  one',
    'after: done',
    'dev.bitop.dev/env: x',
    '---',
    'second: doc',
    '',
  ].join('\n');
  assert.deepEqual(parseYaml(text), [
    {
      a: 1,
      b: 'two # not a comment',
      c: "it's",
      d: true,
      e: [],
      f: {},
      g: ['x', 'y', 3],
      h: [
        { name: 'first', value: '1' },
        { name: 'second', nested: { k: 'v' } },
      ],
      i: ['plain', 7],
      script: 'set -eu\necho "# kept"\n\ntail\n',
      strip: 'one',
      after: 'done',
      'dev.bitop.dev/env': 'x',
    },
    { second: 'doc' },
  ]);
});

test('the parser refuses what it does not understand instead of guessing', () => {
  for (const text of [
    'a: &x 1\nb: *x',
    'a:\n\tb: 1',
    'a: {b: 1}',
    'a: [\n  1,\n  2]',
    'a: >\n  folded',
    '- a\nb: 1',
  ]) {
    assert.throws(() => parseYaml(text), /yaml/i, text);
  }
});

// --- Rendering --------------------------------------------------------------------------------

test('rendering fills every variable and refuses a missing or unsafe one', () => {
  const [stub] = rendered('stub.yaml');
  assert.equal(stub.metadata.name, `${ENV}-scale-stub`);
  const { ENV: _omitted, ...without } = EXAMPLE_VARS;
  assert.throws(() => renderTemplate('stub.yaml', without), /ENV/);
  for (const bad of [
    'a b',
    'x"y',
    'x\ny',
    'x$(id)',
    "x'y",
    'x`y',
    ['$', '{ENV}'].join(''),
    'x;y',
    '',
  ]) {
    assert.throws(
      () => renderTemplate('stub.yaml', { ...EXAMPLE_VARS, SEED: bad }),
      /unsafe|empty/i,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => renderTemplate('stub.yaml', { ...EXAMPLE_VARS, EXTRA: 'x' }),
    /unknown variable/i,
  );
  assert.throws(() => renderTemplate('missing.yaml', EXAMPLE_VARS), /template/i);
});

test('every file in the k8s directory is a registered template', () => {
  const files = readdirSync(K8S)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  assert.deepEqual([...TEMPLATES].sort(), files);
});

// --- Scope: label, namespace, names ------------------------------------------------------------

test('every object carries the environment label, no foreign namespace, and the environment prefix', () => {
  const objects = everything();
  assert.equal(objects.length, 6, 'Deployment, Service, Job, Secret and two ConfigMaps');
  for (const { name, object } of objects) {
    const where = `${name}: ${object.kind}/${object.metadata.name}`;
    assert.equal(object.metadata.labels['dev.bitop.dev/env'], ENV, where);
    assert.ok([undefined, 'dev-oci'].includes(object.metadata.namespace), where);
    assert.ok(object.metadata.name.startsWith(`${ENV}-`), where);
  }
  assert.doesNotThrow(() =>
    checkManifests(
      objects.map((o) => o.object),
      ENV,
    ),
  );
});

test('the manifest check refuses a missing label, another namespace and a foreign name', () => {
  const [stub] = rendered('stub.yaml');
  const label = structuredClone(stub);
  delete label.metadata.labels['dev.bitop.dev/env'];
  assert.throws(() => checkManifests([label], ENV), ScopeError);
  const ns = structuredClone(stub);
  ns.metadata.namespace = 'open-chat-interface';
  assert.throws(() => checkManifests([ns], ENV), /namespace/);
  const name = structuredClone(stub);
  name.metadata.name = 'open-chat-api';
  assert.throws(() => checkManifests([name], ENV), /name/);
});

test('pods carry the label too, so the reaper and `dev-env down` find them', () => {
  for (const { name, object } of everything()) {
    const template =
      object.kind === 'Deployment' || object.kind === 'Job' ? object.spec.template : null;
    if (template) assert.equal(template.metadata.labels['dev.bitop.dev/env'], ENV, name);
  }
});

// --- Pod Security `restricted` -----------------------------------------------------------------

function podSpecs() {
  return everything()
    .filter(({ object }) => object.kind === 'Deployment' || object.kind === 'Job')
    .map(({ name, object }) => ({ name, object, spec: object.spec.template.spec }));
}

test('there is a stub Deployment and Service and a run Job', () => {
  const kinds = everything().map(({ object }) => `${object.kind}/${object.metadata.name}`);
  for (const expected of [
    `Deployment/${ENV}-scale-stub`,
    `Service/${ENV}-scale-stub`,
    `Job/${ENV}-scale-run`,
    `Secret/${ENV}-scale-harness`,
    `ConfigMap/${ENV}-scale-tools`,
    `ConfigMap/${ENV}-scale-env`,
  ]) {
    assert.ok(kinds.includes(expected), expected);
  }
});

test('every container meets the restricted profile', () => {
  const specs = podSpecs();
  assert.ok(specs.length >= 2);
  for (const { name, spec } of specs) {
    assert.equal(spec.hostNetwork, undefined, name);
    assert.equal(spec.hostPID, undefined, name);
    assert.equal(spec.automountServiceAccountToken, false, name);
    for (const volume of spec.volumes) {
      assert.ok(
        volume.emptyDir || volume.configMap,
        `${name}: volume ${volume.name} is neither emptyDir nor configMap`,
      );
    }
    const containers = [...(spec.initContainers ?? []), ...spec.containers];
    for (const c of containers) {
      const where = `${name}/${c.name}`;
      const sc = c.securityContext ?? {};
      assert.equal(sc.allowPrivilegeEscalation, false, where);
      assert.deepEqual(sc.capabilities?.drop, ['ALL'], where);
      assert.equal(sc.capabilities?.add, undefined, where);
      assert.ok(!sc.privileged, where);
      assert.equal(sc.readOnlyRootFilesystem, true, where);
      assert.equal(sc.runAsNonRoot ?? spec.securityContext?.runAsNonRoot, true, where);
      assert.ok(
        Number.isInteger(sc.runAsUser ?? spec.securityContext?.runAsUser),
        `${where}: a numeric user, so the kubelet can check it`,
      );
      assert.notEqual(sc.runAsUser ?? spec.securityContext?.runAsUser, 0, where);
      assert.equal(
        (sc.seccompProfile ?? spec.securityContext?.seccompProfile)?.type,
        'RuntimeDefault',
        where,
      );
    }
  }
});

test('every container has requests and limits, and the load side stays on the load node', () => {
  for (const { name, spec } of podSpecs()) {
    assert.deepEqual(spec.nodeSelector, { 'kubernetes.io/hostname': EXAMPLE_VARS.LOAD_NODE }, name);
    for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
      for (const kind of ['requests', 'limits']) {
        assert.ok(
          c.resources?.[kind]?.cpu && c.resources?.[kind]?.memory,
          `${name}/${c.name} ${kind}`,
        );
      }
    }
  }
});

// --- The run Job -------------------------------------------------------------------------------

const job = () => rendered('run-job.yaml').find((o) => o.kind === 'Job');
const containerNamed = (name) =>
  job().spec.template.spec.initContainers.find((c) => c.name === name);

test('the Job runs the phases in order and ends with a hold container', () => {
  const { spec } = job().spec.template;
  assert.deepEqual(
    spec.initContainers.map((c) => c.name),
    [
      'extract',
      'generate',
      'environment',
      'wait-api',
      'wait-background',
      'warm',
      'baseline',
      'main',
      'collect-main',
      'retention',
      'collect-retention',
      'render',
    ],
  );
  assert.deepEqual(
    spec.containers.map((c) => c.name),
    ['hold'],
  );
  assert.equal(spec.restartPolicy, 'Never');
});

test('the Job has a deadline, no retries, and a single attempt', () => {
  const { spec } = job();
  assert.equal(spec.activeDeadlineSeconds, Number(EXAMPLE_VARS.DEADLINE_SECONDS));
  assert.equal(spec.backoffLimit, 0);
});

test('generator and k6 limits are the spec values', () => {
  const generate = containerNamed('generate');
  assert.deepEqual(generate.resources.limits, { cpu: '2', memory: '2Gi' });
  assert.match(generate.args.join('\n'), /--workers 2\b/);
  for (const phase of ['warm', 'main', 'retention']) {
    assert.deepEqual(containerNamed(phase).resources.limits, { cpu: '2', memory: '2Gi' }, phase);
  }
});

test('the database password reaches containers only through the CNPG Secret', () => {
  const text = renderTemplate('run-job.yaml', EXAMPLE_VARS);
  assert.ok(!text.includes(EXAMPLE_VARS.METRICS_TOKEN ?? '\u0000'));
  for (const c of job().spec.template.spec.initContainers) {
    for (const entry of c.env ?? []) {
      if (['PGPASSWORD', 'PGUSER'].includes(entry.name)) {
        assert.equal(
          entry.valueFrom.secretKeyRef.name,
          `${ENV}-pg-superuser`,
          `${c.name} ${entry.name}`,
        );
        assert.equal(entry.value, undefined);
      }
      if (entry.name === 'SCALE_METRICS_TOKEN') {
        assert.equal(entry.valueFrom.secretKeyRef.name, `${ENV}-scale-harness`);
      }
    }
  }
  // The generator points at the stub through its Service name and is told it is a database admin.
  assert.match(
    containerNamed('generate').args.join('\n'),
    new RegExp(`--stub-url http://${ENV}-scale-stub:4181/v1`),
  );
});

test('k6 talks to the web Service, with the app address as its origin, from the load node', () => {
  const env = Object.fromEntries(containerNamed('main').env.map((e) => [e.name, e.value]));
  assert.equal(env.SCALE_BASE_URL, `http://${ENV}-open-chat-interface-web:8080`);
  assert.equal(env.SCALE_ORIGIN, EXAMPLE_VARS.APP_URL);
  assert.equal(env.SCALE_STUB_URL, `http://${ENV}-scale-stub:4181`);
  assert.equal(env.SCALE_PROFILE, EXAMPLE_VARS.PROFILE);
  assert.equal(env.SCALE_PHASE, 'main');
  assert.equal(containerNamed('main').image, EXAMPLE_VARS.K6_IMAGE);
});

test('collect reads every API replica through the headless Service', () => {
  const env = Object.fromEntries(
    containerNamed('collect-main').env.map((e) => [e.name, e.value ?? e.valueFrom]),
  );
  assert.equal(env.SCALE_API_HOST, `${ENV}-open-chat-interface-api-headless`);
});

test('the secret template carries only the metrics token', () => {
  const secret = rendered('harness-secret.yaml').find((o) => o.kind === 'Secret');
  assert.deepEqual(secret.stringData, { METRICS_TOKEN: EXAMPLE_VARS.METRICS_TOKEN });
});

// --- The stub ----------------------------------------------------------------------------------

test('the stub serves the model on 4181 and is reachable by Service name', () => {
  const docs = rendered('stub.yaml');
  const service = docs.find((o) => o.kind === 'Service');
  const deployment = docs.find((o) => o.kind === 'Deployment');
  assert.equal(service.spec.ports[0].port, 4181);
  assert.deepEqual(service.spec.selector, deployment.spec.selector.matchLabels);
  for (const [key, value] of Object.entries(deployment.spec.selector.matchLabels)) {
    assert.equal(deployment.spec.template.metadata.labels[key], value);
  }
  const main = deployment.spec.template.spec.containers[0];
  assert.deepEqual(main.command, ['node', '/scale/stub/server.mjs']);
  assert.equal(main.readinessProbe.httpGet.path, '/health');
});
