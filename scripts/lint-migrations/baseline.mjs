// Migration linter baseline: grandfathered violations of migrations that predate it.

function baselineKey(entry) {
  return `${entry.file}\u0000${entry.rule}\u0000${entry.fingerprint}`;
}

/**
 * Splits violations into those grandfathered by the baseline and new ones,
 * and lists baseline entries that no longer match anything (stale).
 */
export function applyBaseline(violations, baseline) {
  const remaining = new Map();
  for (const entry of baseline?.entries ?? []) {
    const key = baselineKey(entry);
    remaining.set(key, [...(remaining.get(key) ?? []), entry]);
  }
  const grandfathered = [];
  const fresh = [];
  for (const violation of violations) {
    const matches = remaining.get(baselineKey(violation));
    if (matches?.length) {
      matches.shift();
      grandfathered.push(violation);
    } else {
      fresh.push(violation);
    }
  }
  const stale = [...remaining.values()].flat();
  return { grandfathered, fresh, stale };
}

export function buildBaseline(violations) {
  const entries = violations
    .map(({ file, rule, statement, fingerprint }) => ({ file, rule, statement, fingerprint }))
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.statement - b.statement || a.rule.localeCompare(b.rule),
    );
  return {
    description:
      'Violations in migrations that predate the linter (v0.11). Only these are tolerated; new ones fail. Regenerate with `node scripts/lint-migrations.mjs --update-baseline` (refused in CI). Matching uses file + rule + PostgreSQL fingerprint; statement is informational.',
    entries,
  };
}
