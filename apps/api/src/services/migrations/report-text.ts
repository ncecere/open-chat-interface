import type { UpgradeReport } from '@oci/shared';
import { formatBytes } from './preflight.js';

/** The upgrade preflight as text, for `upgrade-check` (scripts/upgrade-check.ts). */

function rows(value: number | null): string {
  return value === null ? 'rows unknown' : `${value.toLocaleString('en')} rows`;
}

export function renderReport(report: UpgradeReport): string {
  const lines: string[] = [];
  const { bundled, database } = report;
  lines.push('OCI upgrade check');
  lines.push(
    `  This release:     ${bundled.version} (${bundled.migrations} pre-deploy migrations to ${bundled.latestMigration ?? 'none'}, ${bundled.postSteps} post-deploy step(s), ${bundled.backgroundMigrations} background migration(s))`,
  );
  lines.push(
    database.fresh
      ? '  Database schema:  new database, never migrated'
      : `  Database schema:  ${database.release ?? 'before 0.7'} (${database.latestMigration ?? 'a migration this release does not include'}; ${database.applied} applied${database.unknownNewer ? `, ${database.unknownNewer} newer than this release` : ''})`,
  );
  lines.push('');
  lines.push(`Pre-deploy migrations to apply (migrate): ${report.preDeploy.length}`);
  for (const migration of report.preDeploy) {
    lines.push(
      `  ${migration.tag} (${migration.release ?? 'before 0.7'}): ${migration.fast ? 'fast' : 'NOT FAST'}`,
    );
    for (const statement of migration.statements) {
      if (statement.cost === 'catalog' && statement.fast) continue;
      const tables = statement.tables
        .filter((table) => table.exists)
        .map((table) => `${table.name} ${rows(table.rows)}, ${formatBytes(table.bytes ?? 0)}`)
        .join('; ');
      lines.push(`    ${statement.cost}: ${statement.summary}${tables ? ` [${tables}]` : ''}`);
      if (statement.reason) lines.push(`      ${statement.reason}`);
    }
  }
  lines.push('');
  lines.push(
    `Post-deploy steps (migrate --post, after every replica runs ${bundled.version}): ${report.postDeploy.length}`,
  );
  for (const step of report.postDeploy) {
    const tables = step.statement.tables
      .filter((table) => table.exists)
      .map((table) => `${table.name} ${rows(table.rows)}, ${formatBytes(table.bytes ?? 0)}`)
      .join('; ');
    const done =
      step.state === 'finished'
        ? `finished${step.durationMs === null ? '' : ` in ${step.durationMs} ms`}`
        : step.state === 'started'
          ? `started, not finished (${step.attempts} attempt(s)${step.lastError ? `: ${step.lastError}` : ''})`
          : 'pending';
    lines.push(`  ${step.name} (${step.release}): ${done}`);
    lines.push(
      `    ${step.statement.cost}: ${step.statement.summary}${tables ? ` [${tables}]` : ''}`,
    );
    if (step.index && step.state !== 'finished') {
      const size =
        step.index.estimatedBytes === null
          ? 'size unknown'
          : `about ${formatBytes(step.index.estimatedBytes)}${step.index.sizedFromStatistics ? '' : ' (rough)'}`;
      lines.push(
        `    index ${step.index.name ?? '(unnamed)'}: ${size}${step.index.invalidExists ? '; an INVALID copy from an interrupted build will be dropped and rebuilt' : ''}${step.index.exists ? '; already exists' : ''}`,
      );
    }
  }
  lines.push('');
  lines.push(`Background migrations: ${report.background.length}`);
  for (const item of report.background) {
    const progress = item.progress === null ? '' : ` ${Math.round(item.progress * 100)}%`;
    lines.push(
      `  ${item.name} on ${item.table}: ${item.status.replace('_', ' ')}${progress} (${item.rowsProcessed.toLocaleString('en')} of ~${rows(item.estimatedRows)})${item.bundled ? '' : ' [not in this release]'}`,
    );
    if (item.lastError) lines.push(`    last error: ${item.lastError}`);
    if (item.throttledReason && item.status === 'running')
      lines.push(`    waiting: ${item.throttledReason}`);
  }
  lines.push('');
  lines.push(
    `Required by this release and unfinished: ${report.requirements.length === 0 ? 'none' : ''}`,
  );
  for (const requirement of report.requirements) {
    lines.push(
      `  ${requirement.kind} ${requirement.name} (${requirement.state}), required by ${requirement.requiredBy}`,
    );
  }
  if (report.indexes.toBuild > 0) {
    lines.push('');
    lines.push(
      `Disk: ${report.indexes.toBuild} index(es) to build, about ${formatBytes(report.indexes.estimatedBytes)}. OCI cannot read free disk space through SQL: keep at least ${formatBytes(report.indexes.estimatedBytes * 2)} free on the database volume while they build.`,
    );
  }
  if (report.indexes.invalid.length > 0) {
    lines.push(`INVALID indexes: ${report.indexes.invalid.join(', ')}`);
  }
  lines.push('');
  lines.push(`Verdict: ${report.verdict.mode.toUpperCase()}. ${report.verdict.summary}`);
  for (const reason of report.verdict.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}
