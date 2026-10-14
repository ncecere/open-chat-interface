#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a command line tool whose output cluster.sh reads.
/**
 * The pure parts of tools/scale/cluster.sh as commands, so the shell script holds the order of
 * steps and this file (tested in scripts/) holds every decision. Output is meant for the shell:
 * one value or one argument per line. Exit status: 0 fine, 1 a check failed (the reasons are on
 * stderr), 2 refused or misused.
 *
 *   scope [--env NAME] -- <kubectl args>      the arguments with -n dev-oci, or a refusal
 *   render TEMPLATE --env NAME [--example] [KEY=VALUE | KEY@FILE]...
 *   plan PROFILE pgSize|ttlHours|deadlineSeconds|pinRequired
 *   pin --profile P [--node N] [--bound B]
 *   quantity 150Gi
 *   overrides name=value...                   validates fire-drill threshold overrides
 *   patch pg PG_SIZE | patch selector NODE    JSON for kubectl patch
 *   flags api-env ENV | web-env | resources api | retention-env USAGE_DAYS AUDIT_DAYS
 *   teardown-check --profile P --remaining FILE [--pool-before BYTES --pool-after BYTES]
 */

import { readFileSync } from 'node:fs';
import {
  checkManifests,
  decideTeardown,
  jobDeadlineSeconds,
  parseQuantity,
  parseThresholdOverrides,
  pinDecision,
  planFor,
  ScopeError,
  scopeKubectl,
} from './cluster-guard.mjs';
import { EXAMPLE_VARS, renderTemplate } from './cluster-render.mjs';
import {
  apiEnvironment,
  nodeSelectorPatch,
  pgPatch,
  resourceFlags,
  retentionWindows,
  webEnvironment,
} from './cluster-settings.mjs';
import { parseYaml } from './cluster-yaml.mjs';

const [command, ...rest] = process.argv.slice(2);
const out = (text) => console.log(text);
const die = (message, status = 2) => {
  console.error(message);
  process.exit(status);
};

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

try {
  if (command === 'scope') {
    const split = rest.indexOf('--');
    const head = split === -1 ? rest : rest.slice(0, split);
    const env = option(head, '--env');
    for (const arg of scopeKubectl(split === -1 ? [] : rest.slice(split + 1), { env })) out(arg);
  } else if (command === 'render') {
    const args = [...rest];
    const env = option(args, '--env');
    const example = args.includes('--example');
    const pairs = args.filter((a) => a !== '--example');
    const template = pairs.shift();
    const vars = example ? { ...EXAMPLE_VARS } : {};
    for (const pair of pairs) {
      const at = pair.indexOf('@');
      const eq = pair.indexOf('=');
      if (eq > 0 && (at === -1 || eq < at)) vars[pair.slice(0, eq)] = pair.slice(eq + 1);
      else if (at > 0)
        vars[pair.slice(0, at)] = readFileSync(pair.slice(at + 1), 'utf8').replace(/\s+/g, '');
      else die(`Bad variable ${pair}; use KEY=VALUE or KEY@FILE`);
    }
    const name = env ?? vars.ENV;
    const text = renderTemplate(template, vars);
    checkManifests(parseYaml(text), name);
    process.stdout.write(text);
  } else if (command === 'plan') {
    const [profile, field] = rest;
    const plan = planFor(profile);
    const value = { ...plan, deadlineSeconds: jobDeadlineSeconds(plan.ttlHours) }[field];
    if (value === undefined) die(`Unknown plan field ${field}`);
    out(String(value));
  } else if (command === 'pin') {
    const args = [...rest];
    const decision = pinDecision({
      profile: option(args, '--profile'),
      requestedNode: option(args, '--node'),
      boundNode: option(args, '--bound'),
      phase: args.includes('--bound-check') ? 'bound' : 'requested',
    });
    for (const problem of decision.problems) console.error(`pin: ${problem}`);
    process.exit(decision.ok ? 0 : 1);
  } else if (command === 'quantity') {
    out(String(parseQuantity(rest[0])));
  } else if (command === 'overrides') {
    out(JSON.stringify(parseThresholdOverrides(rest)));
  } else if (command === 'patch') {
    const [what, value] = rest;
    if (what === 'pg') out(JSON.stringify(pgPatch(parseQuantity(value))));
    else if (what === 'selector') out(JSON.stringify(nodeSelectorPatch(value)));
    else die(`Unknown patch ${what}`);
  } else if (command === 'flags') {
    const [what, a, b] = rest;
    if (what === 'api-env') {
      const env = apiEnvironment(a);
      for (const [key, value] of Object.entries(env.literals)) out(`${key}=${value}`);
      out(`--from=secret/${env.fromSecret.name}`);
      out(`--keys=${env.fromSecret.keys.join(',')}`);
    } else if (what === 'web-env') {
      for (const [key, value] of Object.entries(webEnvironment())) out(`${key}=${value}`);
    } else if (what === 'resources') {
      for (const flag of resourceFlags(a)) out(flag);
    } else if (what === 'retention-env') {
      const windows = retentionWindows({
        usageDays: a === '' ? null : Number(a),
        auditDays: b === '' ? null : Number(b),
      });
      out(`RETENTION_USAGE_EVENT_DAYS=${windows.usageEvents}`);
      out(`RETENTION_AUDIT_LOG_DAYS=${windows.auditLog}`);
    } else die(`Unknown flags ${what}`);
  } else if (command === 'teardown-check') {
    const args = [...rest];
    const file = option(args, '--remaining');
    const text = file ? readFileSync(file, 'utf8') : null;
    const num = (v) => (v === undefined ? null : Number(v));
    const decision = decideTeardown({
      profile: option(args, '--profile'),
      remaining:
        text === null
          ? null
          : text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
      poolBeforeBytes: num(option(args, '--pool-before')),
      poolAfterBytes: num(option(args, '--pool-after')),
    });
    for (const problem of decision.problems) console.error(`teardown: ${problem}`);
    process.exit(decision.ok ? 0 : 1);
  } else {
    die(`Unknown command ${command ?? ''}; see the header of tools/scale/lib/cluster-cli.mjs`);
  }
} catch (error) {
  die(error instanceof ScopeError ? `refused: ${error.message}` : error.message);
}
