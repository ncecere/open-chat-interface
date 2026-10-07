// Migration linter statement analysis: replays schema state and finds violations.

import { parsePlPgSQLSync, parseSync } from 'libpg-query';
import { walk } from './sql.mjs';

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

function qualifiedName(rangeVar) {
  return `${rangeVar.schemaname ?? 'public'}.${rangeVar.relname}`;
}

function nameFromList(items) {
  const parts = items.map((item) => item.String?.sval);
  return parts.length === 1 ? `public.${parts[0]}` : parts.join('.');
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

export function inspectTopLevel(stmt, text, state, file) {
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
