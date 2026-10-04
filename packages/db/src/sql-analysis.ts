import { loadModule, parsePlPgSQLSync, parseSync } from 'libpg-query';

/**
 * Reads migration SQL with PostgreSQL's own parser (libpg-query, the parser
 * `scripts/lint-migrations.mjs` uses), for the post-deploy runner (which index
 * a step builds) and the upgrade preflight (which tables each step touches and
 * whether its cost grows with them). Never regular expressions: identifiers
 * can be quoted, schema-qualified or inside a DO block.
 */

const BREAKPOINT = '--> statement-breakpoint';

// The parser's AST is a tree of `{ NodeType: { ...fields } }` objects.
// biome-ignore lint/suspicious/noExplicitAny: libpg-query's node union is too wide to narrow usefully here.
type Node = any;

let ready: Promise<void> | undefined;

/** Loads the WebAssembly parser once; every other function here needs it. */
export async function loadSqlParser(): Promise<void> {
  ready ??= loadModule();
  await ready;
}

export interface ParsedStatement {
  /** The statement's own text, without leading comments. */
  text: string;
  /** `IndexStmt`, `AlterTableStmt`, ... */
  type: string;
  node: Node;
}

/** Byte offsets from the parser to string offsets (files may contain UTF-8). */
function slicer(text: string) {
  const buffer = Buffer.from(text, 'utf8');
  return (start: number, end?: number) => buffer.subarray(start, end).toString('utf8');
}

function stripLeadingComments(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const newline = trimmed.indexOf('\n');
      rest = newline === -1 ? '' : trimmed.slice(newline + 1);
    } else if (trimmed.startsWith('/*')) {
      const close = trimmed.indexOf('*/');
      rest = close === -1 ? '' : trimmed.slice(close + 2);
    } else {
      return trimmed.trim();
    }
  }
}

/**
 * Splits migration SQL as Drizzle does (on `--> statement-breakpoint`), then
 * into statements. Throws the parser's error for SQL PostgreSQL would reject.
 */
export function parseStatements(sql: string): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  for (const chunk of sql.split(BREAKPOINT)) {
    const slice = slicer(chunk);
    const parsed = parseSync(chunk) as { stmts?: Node[] };
    for (const entry of parsed.stmts ?? []) {
      const start = entry.stmt_location ?? 0;
      const raw = entry.stmt_len ? slice(start, start + entry.stmt_len) : slice(start);
      const [type, node] = Object.entries(entry.stmt as Record<string, Node>)[0] ?? ['', {}];
      statements.push({ text: stripLeadingComments(raw), type, node });
    }
  }
  return statements;
}

function walk(node: Node, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === 'object') {
    visit(node);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

function qualified(rangeVar: Node): string {
  return `${rangeVar.schemaname ?? 'public'}.${rangeVar.relname}`;
}

/** Statements a DO block runs, parsed; dynamic `EXECUTE` cannot be seen. */
function doBlockStatements(text: string): ParsedStatement[] {
  const queries: string[] = [];
  try {
    walk(parsePlPgSQLSync(text), (node) => {
      const query = node.PLpgSQL_stmt_execsql?.sqlstmt?.PLpgSQL_expr?.query;
      if (typeof query === 'string') queries.push(query);
    });
  } catch {
    return [];
  }
  return queries.flatMap((query) => {
    try {
      return parseStatements(query);
    } catch {
      return [];
    }
  });
}

/**
 * Tables a statement names (schema-qualified, `public` by default), in order
 * of appearance, without duplicates. Includes tables read in subqueries and
 * the statements inside a DO block; CTE names are left out.
 */
export function tablesTouched(statement: ParsedStatement): string[] {
  if (statement.type === 'DoStmt') {
    return [...new Set(doBlockStatements(statement.text).flatMap(tablesTouched))];
  }
  const ctes = new Set<string>();
  const names: string[] = [];
  if (statement.type === 'DropStmt' && statement.node.removeType === 'OBJECT_TABLE') {
    for (const object of statement.node.objects ?? []) {
      const parts = (object.List?.items ?? []).map((item: Node) => item.String?.sval);
      names.push(parts.length === 1 ? `public.${parts[0]}` : parts.join('.'));
    }
  }
  walk(statement.node, (node) => {
    if (node.CommonTableExpr?.ctename) ctes.add(node.CommonTableExpr.ctename);
    if (node.RangeVar?.relname) names.push(qualified(node.RangeVar));
    // Fields such as `relation` hold bare RangeVar objects, not wrapped ones.
    for (const key of ['relation', 'pktable', 'rel']) {
      if (node[key]?.relname) names.push(qualified(node[key]));
    }
  });
  return [
    ...new Set(names.filter((name) => !(name.startsWith('public.') && ctes.has(name.slice(7))))),
  ];
}

export interface IndexBuild {
  schema: string;
  /** Null when PostgreSQL would choose the name. */
  name: string | null;
  table: string;
  concurrent: boolean;
  ifNotExists: boolean;
  unique: boolean;
  method: string;
  /** Plain column names; empty when a key is an expression. */
  columns: string[];
  /** True when any key is an expression. */
  expression: boolean;
  /** The partial index's predicate as written (after WHERE), or null. */
  predicate: string | null;
}

/** The index a `CREATE INDEX` statement builds, or null for any other statement. */
export function indexBuild(statement: ParsedStatement): IndexBuild | null {
  if (statement.type !== 'IndexStmt') return null;
  const node = statement.node;
  const params: Node[] = node.indexParams ?? [];
  const columns = params
    .map((param) => param.IndexElem?.name)
    .filter((name): name is string => typeof name === 'string');
  return {
    schema: node.relation.schemaname ?? 'public',
    name: node.idxname ?? null,
    table: qualified(node.relation),
    concurrent: node.concurrent === true,
    ifNotExists: node.if_not_exists === true,
    unique: node.unique === true,
    method: node.accessMethod ?? 'btree',
    columns,
    expression: columns.length !== params.length,
    predicate: node.whereClause ? predicateText(statement.text) : null,
  };
}

/**
 * The text after an index statement's WHERE: the predicate comes last in
 * CREATE INDEX, so it is the rest of the statement after the last WHERE
 * keyword outside quotes.
 */
function predicateText(text: string): string | null {
  let last = -1;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (
      /^where\b/i.test(text.slice(index, index + 6)) &&
      /\W/.test(text[index - 1] ?? ' ')
    ) {
      last = index;
    }
  }
  if (last === -1) return null;
  return (
    text
      .slice(last + 5)
      .replace(/;\s*$/, '')
      .trim() || null
  );
}

/**
 * How a statement's cost relates to the tables it touches, for the preflight:
 *
 * - `catalog`: a catalog change, independent of table size (a nullable
 *   column, a NOT VALID constraint, a new table);
 * - `scan`: reads every row under a lock that blocks writes (SET NOT NULL, a
 *   validated constraint added in the same transaction);
 * - `rewrite`: rewrites the table under ACCESS EXCLUSIVE (ALTER COLUMN TYPE,
 *   a volatile default, VACUUM FULL, CLUSTER);
 * - `index`: builds an index while blocking writes (no CONCURRENTLY);
 * - `concurrent-index`: builds an index without blocking writes (post-deploy);
 * - `data`: changes existing rows (UPDATE, DELETE, INSERT ... SELECT);
 * - `lock`: an explicit LOCK TABLE.
 */
export type StatementCost =
  | 'catalog'
  | 'scan'
  | 'rewrite'
  | 'index'
  | 'concurrent-index'
  | 'data'
  | 'lock';

const VOLATILE = new Set([
  'random',
  'gen_random_uuid',
  'uuid_generate_v4',
  'clock_timestamp',
  'timeofday',
  'nextval',
  'txid_current',
]);

const WEIGHT: Record<StatementCost, number> = {
  catalog: 0,
  'concurrent-index': 1,
  scan: 2,
  index: 3,
  data: 3,
  rewrite: 4,
  lock: 5,
};

function worst(costs: StatementCost[]): StatementCost {
  return costs.reduce<StatementCost>((a, b) => (WEIGHT[b] > WEIGHT[a] ? b : a), 'catalog');
}

function alterCost(cmd: Node): StatementCost {
  switch (cmd.subtype) {
    case 'AT_AlterColumnType':
      return 'rewrite';
    case 'AT_SetNotNull':
    case 'AT_ValidateConstraint':
      return 'scan';
    case 'AT_AddColumn': {
      const column = cmd.def?.ColumnDef;
      const type = column?.typeName?.names?.at(-1)?.String?.sval;
      if (typeof type === 'string' && /serial/.test(type)) return 'rewrite';
      let cost: StatementCost = 'catalog';
      for (const { Constraint: constraint } of column?.constraints ?? []) {
        if (!constraint) continue;
        if (constraint.contype === 'CONSTR_IDENTITY' || constraint.contype === 'CONSTR_GENERATED')
          return 'rewrite';
        if (constraint.contype === 'CONSTR_DEFAULT') {
          let volatile = false;
          walk(constraint.raw_expr, (node) => {
            const name = node.FuncCall?.funcname?.at(-1)?.String?.sval;
            if (typeof name === 'string' && VOLATILE.has(name.toLowerCase())) volatile = true;
          });
          if (volatile) return 'rewrite';
        }
        if (constraint.contype === 'CONSTR_FOREIGN' || constraint.contype === 'CONSTR_CHECK')
          cost = 'scan';
        if (constraint.contype === 'CONSTR_UNIQUE' || constraint.contype === 'CONSTR_PRIMARY')
          return 'index';
      }
      return cost;
    }
    case 'AT_AddConstraint': {
      const constraint = cmd.def?.Constraint;
      if (!constraint) return 'catalog';
      if (constraint.contype === 'CONSTR_FOREIGN' || constraint.contype === 'CONSTR_CHECK')
        return constraint.skip_validation ? 'catalog' : 'scan';
      if (
        ['CONSTR_UNIQUE', 'CONSTR_PRIMARY', 'CONSTR_EXCLUSION'].includes(constraint.contype) &&
        !constraint.indexname
      )
        return 'index';
      return 'catalog';
    }
    default:
      return 'catalog';
  }
}

/** The statement's cost class; see {@link StatementCost}. */
export function statementCost(statement: ParsedStatement): StatementCost {
  const { type, node } = statement;
  switch (type) {
    case 'IndexStmt':
      return node.concurrent ? 'concurrent-index' : 'index';
    case 'ReindexStmt':
      return (node.params ?? []).some((param: Node) => param.DefElem?.defname === 'concurrently')
        ? 'concurrent-index'
        : 'index';
    case 'AlterTableStmt':
      return worst((node.cmds ?? []).map((cmd: Node) => alterCost(cmd.AlterTableCmd ?? {})));
    case 'UpdateStmt':
    case 'DeleteStmt':
    case 'MergeStmt':
    case 'TruncateStmt':
      return 'data';
    case 'InsertStmt': {
      const select = node.selectStmt?.SelectStmt;
      return !select || (select.valuesLists && !select.fromClause) ? 'catalog' : 'data';
    }
    case 'LockStmt':
      return 'lock';
    case 'VacuumStmt':
      return (node.options ?? []).some((option: Node) => option.DefElem?.defname === 'full')
        ? 'rewrite'
        : 'catalog';
    case 'ClusterStmt':
      return 'rewrite';
    case 'RefreshMatViewStmt':
      return node.concurrent ? 'catalog' : 'scan';
    case 'DoStmt':
      return worst(doBlockStatements(statement.text).map(statementCost));
    default:
      return 'catalog';
  }
}

/** Tables a statement creates (so they are new and empty when it runs). */
export function tablesCreated(statement: ParsedStatement): string[] {
  if (statement.type === 'DoStmt') return doBlockStatements(statement.text).flatMap(tablesCreated);
  if (statement.type === 'CreateStmt') return [qualified(statement.node.relation)];
  if (statement.type === 'CreateTableAsStmt' && statement.node.into?.rel)
    return [qualified(statement.node.into.rel)];
  return [];
}

/** True for statements that cannot run inside a transaction block. */
export function mustRunOutsideTransaction(statement: ParsedStatement): boolean {
  const cost = statementCost(statement);
  if (cost === 'concurrent-index') return true;
  if (statement.type === 'DropStmt' && statement.node.concurrent) return true;
  return statement.type === 'VacuumStmt';
}
