#!/usr/bin/env node
// Migration linter (v0.11 design, section 4).
//
// Parses every Drizzle migration with PostgreSQL's own parser (libpg-query,
// compiled to WebAssembly) and fails on statements that lock or rewrite a table
// that already holds data. "Existing" means created by an earlier migration in
// journal order, or not created by any migration at all; a table created
// earlier in the same file is new and empty, so anything goes.
//
// Post-deploy steps (packages/db/post, v0.11 design section 1) are linted
// after every pre-deploy migration, with post-deploy rules: every table
// exists, CONCURRENTLY is required (and possible: steps run outside a
// transaction), a step is exactly one idempotent statement, and drops are
// allowed only here, with a reason.
//
//   pnpm lint:migrations                      lint packages/db/drizzle and packages/db/post
//   pnpm lint:migrations --dir <folder>       lint another Drizzle folder (and --post-dir)
//   pnpm lint:migrations --update-baseline    rewrite the baseline (never in CI)
//
// An exception is a comment directly above the statement:
//   -- oci:lint-allow <rule>: <reason>
// Migrations 0000-0038 predate the linter; their violations are listed in
// scripts/lint-migrations/baseline.json so that only new ones fail.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprintSync, loadModule, parsePlPgSQLSync, parseSync } from 'libpg-query';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIGRATIONS_DIR = join(repoRoot, 'packages/db/drizzle');
export const DEFAULT_POST_DIR = join(repoRoot, 'packages/db/post');
export const DEFAULT_RELEASE_MANIFEST = join(repoRoot, 'packages/db/releases.json');
export const DEFAULT_BACKGROUND_DIR = join(repoRoot, 'packages/db/src/background');
export const DEFAULT_BASELINE = join(repoRoot, 'scripts/lint-migrations/baseline.json');
const BREAKPOINT = '--> statement-breakpoint';

const BACKGROUND =
  'Change existing rows in a background migration (packages/db/src/background: batched, throttled, resumable; docs/dev/database.md, "Background migrations").';
const POST_DEPLOY =
  'post-deploy step (packages/db/post, run by `migrate --post` outside a transaction; docs/dev/database.md, "Post-deploy steps")';
const DROP_REASON =
  'In a post-deploy step, allow it with a reason that states the previous release no longer reads it: -- oci:lint-allow <rule>: <release> stopped reading it';

/** Statement rules. Each can be allowed inline or grandfathered in the baseline. */
export const RULES = {
  'index-not-concurrent': {
    summary: 'CREATE INDEX (or REINDEX) without CONCURRENTLY on an existing table blocks writes',
    hint: `Build the index with CREATE INDEX CONCURRENTLY in a ${POST_DEPLOY}, or allow it with a reason if the table is known to be small.`,
  },
  'concurrent-in-transaction': {
    summary: 'CONCURRENTLY cannot run inside the transactional pre-deploy migrator',
    hint: `Move the statement to a ${POST_DEPLOY}. A plain CREATE INDEX on a table created in the same release is fine in pre-deploy.`,
  },
  'alter-column-type': {
    summary: 'ALTER COLUMN TYPE on an existing table rewrites it under an ACCESS EXCLUSIVE lock',
    hint: `Add a new column, backfill it in a background migration, switch reads, then drop the old one. A binary-coercible change (varchar(n) to text) does not rewrite; allow it with that reason.`,
  },
  'volatile-default': {
    summary: 'ADD COLUMN with a volatile default, serial, identity or stored generated column',
    hint: `Add the column without the default (or with a constant), set the default separately, and backfill existing rows in a background migration. now()/CURRENT_TIMESTAMP are STABLE and do not rewrite, but give every existing row the migration's time: allow them with a reason if that is intended.`,
  },
  'set-not-null': {
    summary: 'SET NOT NULL on an existing table scans it under an ACCESS EXCLUSIVE lock',
    hint: 'First add CHECK (col IS NOT NULL) NOT VALID and validate it in a later step; SET NOT NULL then uses the validated check and skips the scan.',
  },
  'constraint-not-valid': {
    summary: 'ADD CONSTRAINT (FOREIGN KEY / CHECK) without NOT VALID on an existing table',
    hint: `Add it NOT VALID (fast), then VALIDATE CONSTRAINT in a ${POST_DEPLOY}. For a column added with REFERENCES/CHECK, add the column first and the constraint NOT VALID afterwards.`,
  },
  'unique-constraint': {
    summary:
      'UNIQUE / PRIMARY KEY / EXCLUDE on an existing table builds an index while blocking writes',
    hint: `Build a unique index CONCURRENTLY in a ${POST_DEPLOY}, then ADD CONSTRAINT ... UNIQUE USING INDEX.`,
  },
  'data-change': {
    summary: 'UPDATE / DELETE / TRUNCATE / MERGE / INSERT ... SELECT on an existing table',
    hint: `${BACKGROUND} Plain INSERT ... VALUES of seed rows is allowed.`,
  },
  'drop-column': {
    summary:
      'DROP COLUMN breaks the previous release while it still runs; allowed only in a post-deploy step, with a reason',
    hint: `Stop reading the column in release N, drop it in a ${POST_DEPLOY} of release N+1, so a rollback to N still works (docs/dev/database.md, "Removing a column"). ${DROP_REASON}.`,
    preDeployOnlyHint:
      'A pre-deploy drop cannot be allowed: move the statement to a post-deploy step.',
  },
  'drop-table': {
    summary:
      'DROP TABLE breaks the previous release while it still runs; allowed only in a post-deploy step, with a reason',
    hint: `Stop using the table in release N, drop it in a ${POST_DEPLOY} of release N+1, so a rollback to N still works. ${DROP_REASON}.`,
    preDeployOnlyHint:
      'A pre-deploy drop cannot be allowed: move the statement to a post-deploy step.',
  },
  'lock-table': {
    summary: 'LOCK TABLE holds a table lock for the rest of the migration transaction',
    hint: 'Remove it; every statement takes the lock it needs, bounded by lock_timeout.',
  },
  'refresh-not-concurrent': {
    summary: 'REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of the view',
    hint: 'Use REFRESH MATERIALIZED VIEW CONCURRENTLY (needs a unique index on the view).',
  },
  'vacuum-full': {
    summary: 'VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock',
    hint: 'Leave space reclamation to autovacuum, or run pg_repack outside a migration.',
  },
  cluster: {
    summary: 'CLUSTER rewrites the table under an ACCESS EXCLUSIVE lock',
    hint: 'Do not reorder tables in a migration; run pg_repack outside one if needed.',
  },
  'dynamic-sql': {
    summary: 'EXECUTE of dynamic SQL inside a DO block cannot be checked',
    hint: 'Write the statements out so they can be linted, or allow it with a reason that states what it does.',
  },
  'post-not-idempotent': {
    summary:
      'A post-deploy step is repeated after an interruption, so it must succeed when it already ran',
    hint: 'Use CREATE INDEX CONCURRENTLY IF NOT EXISTS, DROP ... IF EXISTS, DROP COLUMN IF EXISTS or ADD COLUMN IF NOT EXISTS.',
  },
  'post-transaction': {
    summary:
      'A post-deploy step runs outside a transaction: no BEGIN/COMMIT, and no DO block (which runs as one transaction and cannot build CONCURRENTLY)',
    hint: 'Write one plain statement per step; split work that must be atomic into a pre-deploy migration instead.',
  },
};

/**
 * Problems with the linter's own input. Always errors: never allowed inline
 * and never written to the baseline.
 */
export const META_RULES = {
  'parse-error': 'PostgreSQL could not parse the statement',
  'allow-missing-reason': 'oci:lint-allow needs a reason: -- oci:lint-allow <rule>: <reason>',
  'allow-unknown-rule': 'oci:lint-allow names a rule that does not exist',
  'allow-unused': 'oci:lint-allow does not match a violation of the statement below it',
  'allow-not-permitted':
    'this rule cannot be allowed in a pre-deploy migration; move the statement to a post-deploy step',
  'post-one-statement': 'a post-deploy step is exactly one statement (packages/db/post)',
  journal: 'the journal and the migration files disagree',
  'release-manifest':
    'packages/db/releases.json names a migration, post-deploy step or background migration that does not exist',
};

const VOLATILE_FUNCTIONS = new Set([
  'random',
  'random_normal',
  'setseed',
  'gen_random_uuid',
  'uuid_generate_v1',
  'uuid_generate_v1mc',
  'uuid_generate_v4',
  'uuidv4',
  'uuidv7',
  'clock_timestamp',
  'timeofday',
  'nextval',
  'txid_current',
  'pg_current_xact_id',
  // STABLE, not volatile, so PostgreSQL 11+ does not rewrite; flagged because
  // every existing row receives the migration's timestamp.
  'now',
  'statement_timestamp',
  'transaction_timestamp',
]);
const SERIAL_TYPES = new Set([
  'serial',
  'serial4',
  'bigserial',
  'serial8',
  'smallserial',
  'serial2',
]);

let parserReady;
export async function loadParser() {
  parserReady ??= loadModule();
  await parserReady;
}

function qualifiedName(rangeVar) {
  return `${rangeVar.schemaname ?? 'public'}.${rangeVar.relname}`;
}

function nameFromList(items) {
  const parts = items.map((item) => item.String?.sval);
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === 'object') {
    visit(node);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

function volatileCalls(expression) {
  const found = [];
  walk(expression, (node) => {
    const name = node.FuncCall?.funcname?.at(-1)?.String?.sval;
    if (name && VOLATILE_FUNCTIONS.has(name.toLowerCase())) found.push(`${name}()`);
    if (node.SQLValueFunction) {
      found.push(node.SQLValueFunction.op.replace(/^SVFOP_/, '').toUpperCase());
    }
  });
  return found;
}

/** The column a `CHECK (col IS NOT NULL)` constrains, or null. */
function notNullCheckColumn(constraint) {
  const test = constraint.raw_expr?.NullTest;
  if (test?.nulltesttype !== 'IS_NOT_NULL') return null;
  const fields = test.arg?.ColumnRef?.fields;
  return fields?.length === 1 ? (fields[0].String?.sval ?? null) : null;
}

/** Byte offsets from the parser to string offsets (files may contain UTF-8). */
function byteToCharMapper(text) {
  const buffer = Buffer.from(text, 'utf8');
  return (byteOffset) => buffer.subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Splits a migration as Drizzle does (on `--> statement-breakpoint`), then
 * into individual statements with PostgreSQL's parser. Returns, per statement,
 * its text, the offset of its first token and its 1-based line.
 */
export function splitStatements(sql) {
  const statements = [];
  const errors = [];
  let chunkStart = 0;
  for (const chunk of sql.split(BREAKPOINT)) {
    const toChar = byteToCharMapper(chunk);
    let parsed;
    try {
      parsed = parseSync(chunk);
    } catch (error) {
      const firstToken = chunkStart + leadingSkip(chunk);
      errors.push({ offset: firstToken, message: error.message });
      chunkStart += chunk.length + BREAKPOINT.length;
      continue;
    }
    for (const entry of parsed.stmts ?? []) {
      const startByte = entry.stmt_location ?? 0;
      const start = toChar(startByte);
      const end = entry.stmt_len ? toChar(startByte + entry.stmt_len) : chunk.length;
      const raw = chunk.slice(start, end);
      const skip = leadingSkip(raw);
      statements.push({
        stmt: entry.stmt,
        text: raw.slice(skip).trim(),
        offset: chunkStart + start + skip,
      });
    }
    chunkStart += chunk.length + BREAKPOINT.length;
  }
  return { statements, errors };
}

/** Length of the whitespace and comments before a statement's first token. */
function leadingSkip(text) {
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const space = rest.match(/^\s+/);
    if (space) {
      index += space[0].length;
    } else if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      index += newline === -1 ? rest.length : newline + 1;
    } else if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      index += close === -1 ? rest.length : close + 2;
    } else {
      break;
    }
  }
  return index;
}

function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text.charCodeAt(index) === 10) line++;
  }
  return line;
}

const ALLOW_PATTERN = /^--\s*oci:lint-allow\b(.*)$/;

/**
 * `-- oci:lint-allow` comments in the run of comment lines directly above a
 * statement. A blank line or code ends the run; the breakpoint marker does not.
 */
export function allowCommentsAbove(sql, offset) {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1;
  if (sql.slice(lineStart, offset).trim() !== '') return [];
  const lines = sql.slice(0, lineStart).split('\n');
  lines.pop(); // the empty string after the final newline
  const allows = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line === BREAKPOINT) continue;
    if (!line.startsWith('--')) break;
    const match = line.match(ALLOW_PATTERN);
    if (!match) continue;
    const body = match[1].trim();
    const parsed = body.match(/^([a-z0-9-]+)\s*(?::\s*(.*))?$/);
    allows.push({
      line: index + 1,
      rule: parsed?.[1] ?? body,
      reason: (parsed?.[2] ?? '').trim(),
    });
  }
  return allows.reverse();
}

/** Schema state replayed across migrations in journal order. */
export function createSchemaState() {
  return {
    /** qualified table name -> file that created it */
    tables: new Map(),
    /** qualified index name -> qualified table name */
    indexes: new Map(),
    /** qualified table name -> Map(constraint name -> { column, validated }) */
    notNullChecks: new Map(),
  };
}

function checksFor(state, table) {
  let checks = state.notNullChecks.get(table);
  if (!checks) {
    checks = new Map();
    state.notNullChecks.set(table, checks);
  }
  return checks;
}

/**
 * Applies one statement to the schema state and returns its violations. `file`
 * holds the per-file set of tables created in it.
 */
function inspect(stmt, state, file) {
  const found = [];
  const post = file.phase === 'post';
  const isNew = (table) => file.created.has(table);
  const existing = (table) => !isNew(table);
  const where = (table) => {
    const createdIn = state.tables.get(table);
    return createdIn
      ? `existing table ${table} (created in ${createdIn})`
      : `table ${table} (not created by an earlier migration in this folder; assumed to exist)`;
  };
  const flag = (rule, message) => found.push({ rule, message });
  const [type, node] = Object.entries(stmt)[0] ?? [];

  switch (type) {
    case 'CreateStmt': {
      const table = qualifiedName(node.relation);
      if (!state.tables.has(table)) {
        state.tables.set(table, file.name);
        file.created.add(table);
      }
      for (const element of node.tableElts ?? []) {
        const constraint = element.Constraint;
        const column = constraint?.contype === 'CONSTR_CHECK' && notNullCheckColumn(constraint);
        if (column && constraint.conname && isNew(table)) {
          checksFor(state, table).set(constraint.conname, { column, validated: true });
        }
      }
      break;
    }
    case 'CreateTableAsStmt': {
      if (node.objtype !== 'OBJECT_TABLE') break;
      const table = qualifiedName(node.into.rel);
      if (!state.tables.has(table)) {
        state.tables.set(table, file.name);
        file.created.add(table);
      }
      break;
    }
    case 'RenameStmt': {
      if (node.renameType !== 'OBJECT_TABLE') break;
      const from = qualifiedName(node.relation);
      const to = `${node.relation.schemaname ?? 'public'}.${node.newname}`;
      state.tables.set(to, state.tables.get(from) ?? file.name);
      state.tables.delete(from);
      if (file.created.delete(from)) file.created.add(to);
      if (state.notNullChecks.has(from)) {
        state.notNullChecks.set(to, state.notNullChecks.get(from));
        state.notNullChecks.delete(from);
      }
      break;
    }
    case 'DropStmt': {
      if (post && !node.missing_ok) {
        flag('post-not-idempotent', 'DROP without IF EXISTS in a post-deploy step.');
      }
      if (node.removeType !== 'OBJECT_TABLE') break;
      for (const object of node.objects ?? []) {
        const table = nameFromList(object.List?.items ?? []);
        if (existing(table)) flag('drop-table', `DROP TABLE of ${where(table)}.`);
        state.tables.delete(table);
        state.notNullChecks.delete(table);
        file.created.delete(table);
      }
      break;
    }
    case 'AlterTableStmt': {
      if (node.objtype !== 'OBJECT_TABLE') break;
      const table = qualifiedName(node.relation);
      for (const { AlterTableCmd: cmd } of node.cmds ?? []) {
        if (cmd) inspectAlter(cmd, table, { state, existing, where, flag, post });
      }
      break;
    }
    case 'IndexStmt': {
      const table = qualifiedName(node.relation);
      if (node.idxname) {
        state.indexes.set(`${node.relation.schemaname ?? 'public'}.${node.idxname}`, table);
      }
      if (post && !node.if_not_exists) {
        flag('post-not-idempotent', `CREATE INDEX without IF NOT EXISTS on ${table}.`);
      }
      if (node.concurrent) {
        if (!post) {
          flag(
            'concurrent-in-transaction',
            `CREATE INDEX CONCURRENTLY on ${table} cannot run inside the migration transaction.`,
          );
        }
      } else if (existing(table)) {
        flag('index-not-concurrent', `CREATE INDEX without CONCURRENTLY on ${where(table)}.`);
      }
      break;
    }
    case 'ReindexStmt': {
      const concurrent = (node.params ?? []).some(
        (param) => param.DefElem?.defname === 'concurrently',
      );
      if (concurrent) {
        if (!post) {
          flag(
            'concurrent-in-transaction',
            'REINDEX CONCURRENTLY cannot run inside a transaction.',
          );
        }
        break;
      }
      const target = node.relation ? qualifiedName(node.relation) : null;
      const table =
        node.kind === 'REINDEX_OBJECT_INDEX' && target ? state.indexes.get(target) : target;
      if (!table || existing(table)) {
        flag(
          'index-not-concurrent',
          `REINDEX without CONCURRENTLY on ${table ? where(table) : (target ?? 'a whole schema or database')}.`,
        );
      }
      break;
    }
    case 'UpdateStmt':
    case 'DeleteStmt':
    case 'MergeStmt': {
      const table = qualifiedName(node.relation);
      const verb = type.replace('Stmt', '').toUpperCase();
      if (existing(table)) flag('data-change', `${verb} of ${where(table)}.`);
      break;
    }
    case 'TruncateStmt': {
      for (const relation of node.relations ?? []) {
        const table = qualifiedName(relation.RangeVar);
        if (existing(table)) flag('data-change', `TRUNCATE of ${where(table)}.`);
      }
      break;
    }
    case 'InsertStmt': {
      const table = qualifiedName(node.relation);
      const select = node.selectStmt?.SelectStmt;
      const valuesOnly = !select || (select.valuesLists && !select.fromClause);
      if (!valuesOnly && existing(table)) {
        flag('data-change', `INSERT ... SELECT into ${where(table)}.`);
      }
      break;
    }
    case 'LockStmt':
      flag('lock-table', 'LOCK TABLE in a migration.');
      break;
    case 'RefreshMatViewStmt':
      if (!node.concurrent) {
        flag(
          'refresh-not-concurrent',
          `REFRESH MATERIALIZED VIEW ${qualifiedName(node.relation)} without CONCURRENTLY.`,
        );
      }
      break;
    case 'VacuumStmt':
      if ((node.options ?? []).some((option) => option.DefElem?.defname === 'full')) {
        flag('vacuum-full', 'VACUUM FULL in a migration.');
      }
      break;
    case 'ClusterStmt':
      flag('cluster', 'CLUSTER in a migration.');
      break;
    case 'TransactionStmt':
      if (post)
        flag('post-transaction', `${node.kind.replace(/^TRANS_STMT_/, '')} in a post-deploy step.`);
      break;
    default:
      break;
  }
  return found;
}

function inspectAlter(cmd, table, { state, existing, where, flag, post }) {
  switch (cmd.subtype) {
    case 'AT_AddColumn': {
      if (post && !cmd.missing_ok) {
        flag(
          'post-not-idempotent',
          `ADD COLUMN without IF NOT EXISTS on ${table} in a post-deploy step.`,
        );
      }
      if (!existing(table)) break;
      const column = cmd.def?.ColumnDef;
      const typeName = column?.typeName?.names?.at(-1)?.String?.sval;
      const reasons = [];
      if (typeName && SERIAL_TYPES.has(typeName)) reasons.push(`${typeName} column`);
      for (const { Constraint: constraint } of column?.constraints ?? []) {
        if (!constraint) continue;
        if (constraint.contype === 'CONSTR_DEFAULT') {
          const calls = volatileCalls(constraint.raw_expr);
          if (calls.length) reasons.push(`default ${calls.join(', ')}`);
        } else if (constraint.contype === 'CONSTR_IDENTITY') {
          reasons.push('identity column');
        } else if (constraint.contype === 'CONSTR_GENERATED') {
          reasons.push('stored generated column');
        } else if (
          constraint.contype === 'CONSTR_FOREIGN' ||
          constraint.contype === 'CONSTR_CHECK'
        ) {
          flag(
            'constraint-not-valid',
            `ADD COLUMN ${column.colname} with an inline ${constraint.contype === 'CONSTR_FOREIGN' ? 'REFERENCES' : 'CHECK'} on ${where(table)} validates every row.`,
          );
        } else if (
          constraint.contype === 'CONSTR_UNIQUE' ||
          constraint.contype === 'CONSTR_PRIMARY'
        ) {
          flag(
            'unique-constraint',
            `ADD COLUMN ${column.colname} with an inline ${constraint.contype === 'CONSTR_UNIQUE' ? 'UNIQUE' : 'PRIMARY KEY'} on ${where(table)} builds an index.`,
          );
        }
      }
      if (reasons.length) {
        flag(
          'volatile-default',
          `ADD COLUMN ${column?.colname} (${reasons.join('; ')}) on ${where(table)}.`,
        );
      }
      break;
    }
    case 'AT_AlterColumnType':
      if (existing(table)) {
        flag('alter-column-type', `ALTER COLUMN ${cmd.name} TYPE on ${where(table)}.`);
      }
      break;
    case 'AT_SetNotNull': {
      if (!existing(table)) break;
      const checks = state.notNullChecks.get(table);
      const covered = [...(checks?.values() ?? [])].some(
        (check) => check.column === cmd.name && check.validated,
      );
      if (!covered) {
        flag(
          'set-not-null',
          `SET NOT NULL on ${cmd.name} of ${where(table)} without a validated CHECK (${cmd.name} IS NOT NULL).`,
        );
      }
      break;
    }
    case 'AT_AddConstraint': {
      const constraint = cmd.def?.Constraint;
      if (!constraint) break;
      const column = constraint.contype === 'CONSTR_CHECK' && notNullCheckColumn(constraint);
      if (column && constraint.conname) {
        checksFor(state, table).set(constraint.conname, {
          column,
          validated: !constraint.skip_validation || !existing(table),
        });
      }
      if (!existing(table)) break;
      const kind = constraint.contype;
      const named = constraint.conname ? `ADD CONSTRAINT ${constraint.conname}` : 'ADD';
      if ((kind === 'CONSTR_FOREIGN' || kind === 'CONSTR_CHECK') && !constraint.skip_validation) {
        const what = kind === 'CONSTR_FOREIGN' ? 'FOREIGN KEY' : 'CHECK';
        flag('constraint-not-valid', `${named} ${what} without NOT VALID on ${where(table)}.`);
      } else if (
        (kind === 'CONSTR_UNIQUE' || kind === 'CONSTR_PRIMARY' || kind === 'CONSTR_EXCLUSION') &&
        !constraint.indexname
      ) {
        const what = { CONSTR_UNIQUE: 'UNIQUE', CONSTR_PRIMARY: 'PRIMARY KEY' }[kind] ?? 'EXCLUDE';
        flag('unique-constraint', `${named} ${what} on ${where(table)} builds an index.`);
      }
      break;
    }
    case 'AT_ValidateConstraint': {
      const check = state.notNullChecks.get(table)?.get(cmd.name);
      if (check) check.validated = true;
      break;
    }
    case 'AT_DropConstraint':
      state.notNullChecks.get(table)?.delete(cmd.name);
      break;
    case 'AT_DropColumn':
      if (post && !cmd.missing_ok) {
        flag('post-not-idempotent', `DROP COLUMN ${cmd.name} without IF EXISTS on ${table}.`);
      }
      if (existing(table)) flag('drop-column', `DROP COLUMN ${cmd.name} of ${where(table)}.`);
      break;
    default:
      break;
  }
}

/** SQL statements a DO block runs, from PostgreSQL's PL/pgSQL parser. */
function doBlockStatements(text) {
  const parsed = parsePlPgSQLSync(text);
  const queries = [];
  let dynamic = 0;
  walk(parsed, (node) => {
    const query = node.PLpgSQL_stmt_execsql?.sqlstmt?.PLpgSQL_expr?.query;
    if (query) queries.push(query);
    if (node.PLpgSQL_stmt_dynexecute) dynamic++;
  });
  return { queries, dynamic };
}

function inspectTopLevel(stmt, text, state, file) {
  if (!stmt.DoStmt) return inspect(stmt, state, file);
  const found = [];
  if (file.phase === 'post') {
    found.push({ rule: 'post-transaction', message: 'DO block in a post-deploy step.' });
  }
  let block;
  try {
    block = doBlockStatements(text);
  } catch (error) {
    return [{ rule: 'parse-error', message: `DO block: ${error.message}` }];
  }
  for (const query of block.queries) {
    let parsed;
    try {
      parsed = parseSync(query);
    } catch (error) {
      found.push({ rule: 'parse-error', message: `Inside DO block: ${error.message}` });
      continue;
    }
    for (const entry of parsed.stmts ?? []) {
      for (const violation of inspect(entry.stmt, state, file)) {
        found.push({ ...violation, message: `${violation.message} (inside a DO block)` });
      }
    }
  }
  if (block.dynamic) {
    found.push({
      rule: 'dynamic-sql',
      message: `DO block runs ${block.dynamic} dynamic EXECUTE statement(s) the linter cannot see.`,
    });
  }
  return found;
}

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

/** Reads a Drizzle folder in journal order and checks journal/file agreement. */
export function readMigrationsFolder(dir) {
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const migrations = [];
  const errors = [];
  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index) {
      errors.push({
        rule: 'journal',
        file: 'meta/_journal.json',
        message: `Entry ${index} (${entry.tag}) has idx ${entry.idx}; indexes must be sequential.`,
      });
    }
    const name = `${entry.tag}.sql`;
    const path = join(dir, name);
    if (!existsSync(path)) {
      errors.push({
        rule: 'journal',
        file: name,
        message: `Journal entry ${entry.tag} has no file.`,
      });
      return;
    }
    migrations.push({ name, sql: readFileSync(path, 'utf8') });
  });
  const listed = new Set(journal.entries.map((entry) => `${entry.tag}.sql`));
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    if (!listed.has(name)) {
      errors.push({
        rule: 'journal',
        file: name,
        message: `${name} is not in meta/_journal.json, so the migrator will never run it.`,
      });
    }
  }
  return { migrations, errors };
}

/** Prefix of post-deploy step names in reports and the baseline. */
export const POST_PREFIX = 'post/';

/**
 * Reads a post-deploy folder (`journal.json` listing `NNNN_name.sql` files) in
 * journal order, as `{ name: 'post/<file>', sql, phase: 'post' }`, and checks
 * the journal and files agree. A missing folder has no steps.
 */
export function readPostFolder(dir) {
  const journalPath = join(dir, 'journal.json');
  if (!existsSync(journalPath)) return { migrations: [], errors: [] };
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const migrations = [];
  const errors = [];
  (journal.steps ?? []).forEach((entry, index) => {
    if (entry.idx !== index) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}journal.json`,
        message: `Step ${index} (${entry.tag}) has idx ${entry.idx}; indexes must be sequential.`,
      });
    }
    if (!entry.release) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}journal.json`,
        message: `Step ${entry.tag} names no release.`,
      });
    }
    const name = `${entry.tag}.sql`;
    if (!existsSync(join(dir, name))) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}${name}`,
        message: `Post-deploy journal entry ${entry.tag} has no file.`,
      });
      return;
    }
    migrations.push({
      name: `${POST_PREFIX}${name}`,
      sql: readFileSync(join(dir, name), 'utf8'),
      phase: 'post',
    });
  });
  const listed = new Set((journal.steps ?? []).map((entry) => `${entry.tag}.sql`));
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    if (!listed.has(name)) {
      errors.push({
        rule: 'journal',
        file: `${POST_PREFIX}${name}`,
        message: `${name} is not in journal.json, so \`migrate --post\` will never run it.`,
      });
    }
  }
  return { migrations, errors };
}

/**
 * Checks packages/db/releases.json against what exists: each release's first
 * migration is in the journal, in release order, and every required
 * post-deploy step is in the post journal and every required background
 * migration is a name defined in packages/db/src/background.
 */
export function checkReleaseManifest({ manifest, migrations, postSteps, backgroundSource }) {
  const errors = [];
  const fail = (message) =>
    errors.push({ rule: 'release-manifest', file: '../releases.json', message });
  const position = new Map(migrations.map((name, index) => [name.replace(/\.sql$/, ''), index]));
  let previous = -1;
  for (const release of manifest.releases ?? []) {
    const at = position.get(release.firstMigration);
    if (at === undefined) {
      fail(
        `Release ${release.version} starts at ${release.firstMigration}, which is not in the journal.`,
      );
      continue;
    }
    if (at <= previous)
      fail(`Release ${release.version} does not start after the release before it.`);
    previous = at;
    for (const step of release.requires?.postSteps ?? []) {
      if (!postSteps.includes(step)) {
        fail(
          `Release ${release.version} requires post-deploy step ${step}, which is not in post/journal.json.`,
        );
      }
    }
    for (const name of release.requires?.backgroundMigrations ?? []) {
      if (!backgroundSource.includes(`'${name}'`)) {
        fail(
          `Release ${release.version} requires background migration ${name}, which no definition in packages/db/src/background names.`,
        );
      }
    }
  }
  return errors;
}

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

function formatProblem(problem, dir, postDir) {
  const path =
    postDir && problem.file.startsWith(POST_PREFIX)
      ? join(postDir, problem.file.slice(POST_PREFIX.length))
      : join(dir, problem.file);
  const where = `${relative(process.cwd(), path) || problem.file}${problem.line ? `:${problem.line}` : ''}`;
  const statement = problem.statement ? ` statement ${problem.statement}` : '';
  const rule = RULES[problem.rule];
  const lines = [`${where}${statement} [${problem.rule}] ${problem.message}`];
  if (rule) {
    lines.push(`  why: ${rule.summary}.`);
    lines.push(`  fix: ${rule.hint}`);
    lines.push(`  or allow it: -- oci:lint-allow ${problem.rule}: <reason>`);
  } else if (META_RULES[problem.rule]) {
    lines.push(`  ${META_RULES[problem.rule]}.`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    dir: DEFAULT_MIGRATIONS_DIR,
    postDir: undefined,
    baseline: DEFAULT_BASELINE,
    update: false,
  };
  let dirGiven = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--update-baseline') options.update = true;
    else if (arg === '--dir') {
      options.dir = resolve(argv[++index] ?? '');
      dirGiven = true;
    } else if (arg === '--post-dir') options.postDir = resolve(argv[++index] ?? '');
    else if (arg === '--baseline') options.baseline = resolve(argv[++index] ?? '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  // Another Drizzle folder has no post-deploy steps unless they are named.
  if (options.postDir === undefined && !dirGiven) options.postDir = DEFAULT_POST_DIR;
  return options;
}

/** Runs the linter; returns the exit code. `log`/`error` are injectable for tests. */
export async function main(
  argv,
  { env = process.env, log = console.log, error = console.error } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    error(failure.message);
    return 2;
  }
  if (options.help) {
    log(
      'Usage: node scripts/lint-migrations.mjs [--dir <drizzle folder>] [--post-dir <post-deploy folder>] [--baseline <file>] [--update-baseline]',
    );
    return 0;
  }
  await loadParser();
  const { migrations, errors: journalErrors } = readMigrationsFolder(options.dir);
  const post = options.postDir ? readPostFolder(options.postDir) : { migrations: [], errors: [] };
  const result = lintMigrations([...migrations, ...post.migrations]);
  const errors = [...journalErrors, ...post.errors, ...result.errors];
  if (options.postDir === DEFAULT_POST_DIR && existsSync(DEFAULT_RELEASE_MANIFEST)) {
    const backgroundSource = readdirSync(DEFAULT_BACKGROUND_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(DEFAULT_BACKGROUND_DIR, name), 'utf8'))
      .join('\n');
    errors.push(
      ...checkReleaseManifest({
        manifest: JSON.parse(readFileSync(DEFAULT_RELEASE_MANIFEST, 'utf8')),
        migrations: migrations.map((migration) => migration.name),
        postSteps: post.migrations.map((step) => step.name.slice(POST_PREFIX.length, -4)),
        backgroundSource,
      }),
    );
  }
  const format = (problem) => formatProblem(problem, options.dir, options.postDir);

  if (options.update) {
    if (env.CI) {
      error(
        'Refusing to write the migration lint baseline in CI. Run --update-baseline locally and commit the result.',
      );
      return 2;
    }
    if (errors.length) {
      for (const problem of errors) error(format(problem));
      error('Fix the errors above before updating the baseline.');
      return 1;
    }
    writeFileSync(
      options.baseline,
      `${JSON.stringify(buildBaseline(result.violations), null, 2)}\n`,
    );
    log(
      `Wrote ${result.violations.length} baseline entries to ${relative(process.cwd(), options.baseline)}.`,
    );
    return 0;
  }

  const baseline = existsSync(options.baseline)
    ? JSON.parse(readFileSync(options.baseline, 'utf8'))
    : { entries: [] };
  const { grandfathered, fresh, stale } = applyBaseline(result.violations, baseline);
  for (const problem of [...errors, ...fresh]) error(`${format(problem)}\n`);
  for (const entry of stale) {
    error(
      `${entry.file} statement ${entry.statement} [${entry.rule}] stale baseline entry: no matching violation. ` +
        'Migrations that have shipped must not change; if this is intended, run --update-baseline locally.\n',
    );
  }
  const failed = errors.length + fresh.length + stale.length;
  const postSummary = options.postDir
    ? ` and ${post.migrations.length} post-deploy step(s) in ${relative(process.cwd(), options.postDir) || basename(options.postDir)}`
    : '';
  const summary =
    `Checked ${migrations.length} migrations (${result.statementCount} statements) in ` +
    `${relative(process.cwd(), options.dir) || basename(options.dir)}${postSummary}: ` +
    `${grandfathered.length} grandfathered by the baseline, ${fresh.length} new violation(s), ` +
    `${errors.length} error(s), ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}.`;
  (failed ? error : log)(summary);
  if (failed) {
    error(
      'See docs/dev/database.md, "Migration linter", for the rules and how to allow an exception.',
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
