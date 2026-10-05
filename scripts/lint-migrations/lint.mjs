// Migration linter driver: lints migrations in journal order and applies allow comments.

import { fingerprintSync } from 'libpg-query';
import { createSchemaState, inspectTopLevel } from './inspect.mjs';
import { META_RULES, RULES } from './rules.mjs';
import { allowCommentsAbove, lineOf, splitStatements } from './sql.mjs';

/** Rules an allow comment cannot waive in a pre-deploy migration. */
const POST_DEPLOY_ONLY = new Set(
  Object.entries(RULES)
    .filter(([, rule]) => rule.preDeployOnlyHint)
    .map(([name]) => name),
);

/**
 * Lints migrations in journal order. `migrations` is [{ name, sql, phase? }],
 * pre-deploy first; `phase: 'post'` marks a post-deploy step. Returns
 * statement violations (each with a fingerprint for the baseline) and meta
 * errors (bad allow comments, parse failures), which can never be suppressed.
 */
export function lintMigrations(migrations, state = createSchemaState()) {
  const violations = [];
  const errors = [];
  let statementCount = 0;
  for (const migration of migrations) {
    const phase = migration.phase === 'post' ? 'post' : 'pre';
    const file = { name: migration.name, created: new Set(), phase };
    const { statements, errors: parseErrors } = splitStatements(migration.sql);
    if (phase === 'post' && parseErrors.length === 0 && statements.length !== 1) {
      errors.push({
        rule: 'post-one-statement',
        file: migration.name,
        line: statements[1] ? lineOf(migration.sql, statements[1].offset) : 1,
        message: `Post-deploy step has ${statements.length} statements; split it into one file per statement.`,
      });
    }
    for (const failure of parseErrors) {
      errors.push({
        rule: 'parse-error',
        file: migration.name,
        line: lineOf(migration.sql, failure.offset),
        message: failure.message,
      });
    }
    statements.forEach((statement, index) => {
      statementCount++;
      const line = lineOf(migration.sql, statement.offset);
      const location = { file: migration.name, statement: index + 1, line };
      const allows = allowCommentsAbove(migration.sql, statement.offset);
      const found = inspectTopLevel(statement.stmt, statement.text, state, file);
      const used = new Set();
      for (const allow of allows) {
        if (!RULES[allow.rule]) {
          errors.push({
            ...location,
            rule: 'allow-unknown-rule',
            message: `Unknown rule "${allow.rule}" in oci:lint-allow (line ${allow.line}). Rules: ${Object.keys(RULES).join(', ')}.`,
          });
        } else if (!allow.reason) {
          errors.push({
            ...location,
            rule: 'allow-missing-reason',
            message: `oci:lint-allow ${allow.rule} (line ${allow.line}) has no reason; write "-- oci:lint-allow ${allow.rule}: <why this is safe>".`,
          });
        }
      }
      let fingerprint;
      for (const violation of found) {
        if (META_RULES[violation.rule]) {
          errors.push({ ...location, ...violation });
          continue;
        }
        const allow = allows.find((entry) => entry.rule === violation.rule && entry.reason);
        if (allow && phase === 'pre' && POST_DEPLOY_ONLY.has(violation.rule)) {
          used.add(allow);
          errors.push({
            ...location,
            rule: 'allow-not-permitted',
            message: `oci:lint-allow ${allow.rule} (line ${allow.line}) is not accepted in a pre-deploy migration. ${RULES[allow.rule].preDeployOnlyHint}`,
          });
        } else if (allow) {
          used.add(allow);
          continue;
        }
        fingerprint ??= fingerprintSync(statement.text);
        violations.push({ ...location, ...violation, fingerprint, text: statement.text });
      }
      for (const allow of allows) {
        if (RULES[allow.rule] && allow.reason && !used.has(allow)) {
          errors.push({
            ...location,
            rule: 'allow-unused',
            message: `oci:lint-allow ${allow.rule} (line ${allow.line}) matches no ${allow.rule} violation in the statement below it.`,
          });
        }
      }
    });
  }
  return { violations, errors, statementCount, state };
}
