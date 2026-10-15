/**
 * The audit's evidence: counts and findings per criterion and route, and nothing else.
 *
 * No screenshots, no page text, no addresses or secrets: what is stored is a selector, a rule
 * and a number. `redact` is applied to everything that came from a page. The same defect
 * found in forty contexts is one finding with its contexts counted, so the file stays small
 * enough to read and to review in a diff.
 */

import { criterion } from './wcag.mjs';

export const SEVERITIES = ['critical', 'serious', 'moderate', 'minor', 'review'];

const MAX_TARGETS = 5;
const MAX_CONTEXTS = 24;

/** Strips what must not be written: addresses, secrets, query strings, long opaque tokens. */
export function redact(text) {
  return String(text)
    .replace(/Disposable-[\w-]+-Pw1!/g, '<password>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/g, '$1?<query>')
    .replace(/[A-Za-z0-9_-]{32,}/g, '<token>');
}

/** @param {{ role: string, theme: string, accent: string, viewport: number | string, language: string }} context */
export function contextKey(context) {
  return [context.role, context.theme, context.accent, context.viewport, context.language].join(
    '/',
  );
}

function groupPairs(pairs) {
  const groups = {};
  for (const entry of pairs.values()) {
    const { group, routes, ...rest } = entry;
    groups[group] ??= [];
    groups[group].push({ ...rest, routeCount: routes.size });
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.ratio - b.ratio);
  return groups;
}

export function createEvidence() {
  const criteria = new Map();
  const checks = new Map();
  const findings = new Map();
  const pairs = new Map();
  const facts = {};

  const forCheck = (name) => {
    if (!checks.has(name)) {
      checks.set(name, { samples: 0, occurrences: 0, limits: new Set(), counters: {} });
    }
    return checks.get(name);
  };
  const forCriterion = (id) => {
    if (!criterion(id))
      throw new Error(`Unknown criterion ${id}: it is not a WCAG 2.2 A or AA criterion`);
    if (!criteria.has(id))
      criteria.set(id, { samples: 0, failures: 0, routes: new Map(), checks: new Set() });
    return criteria.get(id);
  };
  const forRoute = (entry, route) => {
    if (!entry.routes.has(route)) entry.routes.set(route, { samples: 0, failures: 0 });
    return entry.routes.get(route);
  };

  return {
    /** One thing was evaluated for these criteria on this route in this context. */
    sample(ids, check, route) {
      forCheck(check).samples += 1;
      for (const id of ids) {
        const entry = forCriterion(id);
        entry.samples += 1;
        entry.checks.add(check);
        forRoute(entry, route).samples += 1;
      }
    },

    finding({
      criteria: ids,
      check,
      rule,
      severity,
      route,
      context,
      message,
      targets = [],
      detail,
    }) {
      if (!SEVERITIES.includes(severity)) throw new Error(`Unknown severity ${severity}`);
      for (const id of ids) forCriterion(id);
      const shown = targets.slice(0, MAX_TARGETS).map(redact);
      const key = [check, rule, route, [...shown].sort().slice(0, 3).join('|')].join('::');
      let entry = findings.get(key);
      if (!entry) {
        entry = {
          id: `F${String(findings.size + 1).padStart(3, '0')}`,
          criteria: [...ids],
          check,
          rule,
          severity,
          route,
          message: redact(message),
          ...(detail === undefined ? {} : { detail: JSON.parse(redact(JSON.stringify(detail))) }),
          targets: shown,
          occurrences: 0,
          contexts: new Set(),
        };
        findings.set(key, entry);
      }
      entry.occurrences += 1;
      entry.contexts.add(contextKey(context));
      forCheck(check).occurrences += 1;
      for (const id of ids) {
        const criterionEntry = forCriterion(id);
        criterionEntry.failures += 1;
        criterionEntry.checks.add(check);
        forRoute(criterionEntry, route).failures += 1;
      }
    },

    /**
     * One foreground and background pair, as rendered in a theme and accent. Kept whole so the
     * report can list every pair that was measured, not only those that failed.
     */
    pair(group, route, record) {
      const key = [group, record.kind, record.fg, record.bg, record.required].join('|');
      let entry = pairs.get(key);
      if (!entry) {
        entry = { group, ...record, count: 0, routes: new Set() };
        pairs.set(key, entry);
      }
      entry.count += record.count ?? 1;
      entry.routes.add(route);
    },

    /**
     * A recorded observation that is not a pass or a failure: a page title, the tab stops of a
     * walkthrough. `section` and `key` address it in evidence.json.
     */
    fact(section, key, value) {
      facts[section] ??= {};
      facts[section][key] = JSON.parse(redact(JSON.stringify(value)));
    },

    /** What a check cannot see, kept with the check so the report can say it. */
    limit(check, text) {
      forCheck(check).limits.add(text);
    },

    /** A tally that is neither a pass nor a failure, such as samples that could not be judged. */
    count(check, name, amount = 1) {
      const entry = forCheck(check);
      entry.counters[name] = (entry.counters[name] ?? 0) + amount;
    },

    toJSON() {
      const criteriaOut = {};
      for (const [id, entry] of [...criteria].sort(([a], [b]) =>
        a.localeCompare(b, 'en', { numeric: true }),
      )) {
        const own = [...findings.values()].filter((finding) => finding.criteria.includes(id));
        criteriaOut[id] = {
          samples: Math.max(entry.samples, entry.failures),
          failures: entry.failures,
          findingCount: own.length,
          checks: [...entry.checks].sort(),
          routes: Object.fromEntries(
            [...entry.routes]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([route, counts]) => [
                route,
                { samples: Math.max(counts.samples, counts.failures), failures: counts.failures },
              ]),
          ),
        };
      }
      const checksOut = {};
      for (const [name, entry] of [...checks].sort(([a], [b]) => a.localeCompare(b))) {
        checksOut[name] = {
          samples: entry.samples,
          occurrences: entry.occurrences,
          counters: entry.counters,
          limits: [...entry.limits],
        };
      }
      return {
        criteria: criteriaOut,
        checks: checksOut,
        contrastPairs: groupPairs(pairs),
        facts,
        findings: [...findings.values()].map((finding) => ({
          ...finding,
          contextCount: finding.contexts.size,
          contexts: [...finding.contexts].sort().slice(0, MAX_CONTEXTS),
        })),
      };
    },
  };
}
