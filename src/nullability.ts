// Decides which output columns can never be NULL. The rule is conservative by design: a column is
// non-null only when we can prove it, and every doubt makes it nullable. The eval harness measures
// both directions against a real Postgres: a wrong "non-null" is a soundness failure, a needless
// "nullable" costs precision.
//
// Two sources of proof, tried in order for each output column:
// 1. The select list itself. Column references are resolved to the FROM item they name, the way
//    Postgres resolves them, so `child.id` in `categories child LEFT JOIN categories parent` is
//    known to come from the side that is never NULL-extended. Expressions are proven from their
//    parts: literals, count(*), COALESCE, casts and operators of non-null values, and so on.
// 2. The column's origin, which Postgres reports for plain table columns even through subqueries
//    and CTEs. It is trusted only when that table is on no nullable side anywhere in the statement.
import { loadModule, parseSync } from "libpg-query";
import type { Engine, FieldDescription, Overrides } from "./engine.ts";

let loaded: Promise<void> | undefined;
export function ready(): Promise<void> {
  return (loaded ??= loadModule());
}

type Node = Record<string, any>;

/**
 * Deliberate bugs the eval harness switches on one at a time, to prove its oracle catches each of
 * them (mutation testing). Empty in normal use.
 */
export const mutations = new Set<string>();

/** For each output column Postgres described for `sql`, whether it can never be NULL. */
export async function outputNotNull(sql: string, fields: FieldDescription[], engine: Engine): Promise<boolean[]> {
  await ready();
  const stmt: Node = (parseSync(sql) as Node).stmts?.[0]?.stmt ?? {};
  const facts = await statementFacts(stmt, engine);
  const ctx: Context = { engine, facts, scope: await scopeOf(stmt, facts, engine), nulled: groupingNulled(stmt) };
  const targets = alignedTargets(stmt, fields.length);
  const out: boolean[] = [];
  for (let i = 0; i < fields.length; i++) out.push(await fieldNotNull(fields[i], targets?.[i], ctx));
  return out;
}

interface Context {
  engine: Engine;
  facts: Facts;
  /** The top-level FROM items (and a DML statement's target), which the select list can name. */
  scope: FromItem[];
  /** Expressions a grouping set can set to NULL in subtotal rows. */
  nulled: (e: Node) => boolean;
}

async function fieldNotNull(field: FieldDescription, target: Node | undefined, ctx: Context): Promise<boolean> {
  if (target?.ColumnRef && !isStar(target)) {
    const value = await resolveColumn(target.ColumnRef, ctx);
    // A resolved reference is decisive. It must agree with the origin Postgres reports.
    if (value) return sameOrigin(value, field) && valueNotNull(value, ctx);
  }
  if (target && (await provenNotNull(target, ctx))) return true;
  return originNotNull(field, ctx);
}

// ---------------------------------------------------------------------------------------------
// Whole-statement facts, for columns known only by their origin.

interface Facts {
  /** CTE names anywhere in the statement; a FROM item with one of these names is not a table. */
  cteNames: Set<string>;
  /** Relations (OIDs) that appear on the nullable side of an outer join anywhere in the statement. */
  nullableRelations: Set<number>;
  /** A relation on a nullable side could not be resolved, so no column origin can be trusted. */
  unresolvedNullable: boolean;
  /** GROUPING SETS / ROLLUP / CUBE: grouped columns become NULL in subtotal rows. */
  groupingSets: boolean;
  /** A UNION/INTERSECT/EXCEPT feeds the output (top level, FROM, or a CTE). */
  setOperation: boolean;
  /**
   * DML targets whose RETURNING is not bound by the table's constraints: views (an INSTEAD OF
   * trigger returns what it likes) and relations with rewrite rules.
   */
  untrustedTargets: Set<number>;
}

async function statementFacts(stmt: Node, engine: Engine): Promise<Facts> {
  const ctes = new Map<string, Node>();
  walk(stmt, (n) => {
    const cte = n.CommonTableExpr;
    if (cte?.ctename && cte.ctequery) ctes.set(cte.ctename, cte.ctequery);
  });

  const facts: Facts = {
    cteNames: new Set(ctes.keys()),
    nullableRelations: new Set(),
    unresolvedNullable: false,
    groupingSets: false,
    setOperation: false,
    untrustedTargets: new Set(),
  };

  // Outer joins, and MERGE ... WHEN NOT MATCHED BY SOURCE, which returns target rows that have no
  // source row.
  const nullableSides: Node[] = [];
  walk(stmt, (n) => {
    const m = n.MergeStmt;
    if (m && mergeBySource(m)) nullableSides.push(m.sourceRelation);
    const j = n.JoinExpr;
    if (!j) return;
    if (j.jointype === "JOIN_LEFT") nullableSides.push(j.rarg);
    else if (j.jointype === "JOIN_RIGHT") nullableSides.push(j.larg);
    else if (j.jointype === "JOIN_FULL") nullableSides.push(j.larg, j.rarg);
  });
  const names = new Set<string>();
  const visitedCtes = new Set<string>();
  const collect = (side: Node) =>
    walk(side, (n) => {
      const rv = n.RangeVar;
      if (!rv?.relname) return;
      if (!rv.schemaname && ctes.has(rv.relname)) {
        if (mutations.has("skip-cte-references")) return;
        if (!visitedCtes.has(rv.relname)) {
          visitedCtes.add(rv.relname);
          collect(ctes.get(rv.relname)!);
        }
        return;
      }
      names.add(relationName(rv));
    });
  if (!mutations.has("ignore-outer-joins")) for (const side of nullableSides) collect(side);
  for (const name of names) {
    const oid = await engine.relationOid(name);
    if (oid === null) facts.unresolvedNullable = true;
    else facts.nullableRelations.add(oid);
  }

  walk(stmt, (n) => {
    if (n.GroupingSet && !mutations.has("ignore-grouping-sets")) facts.groupingSets = true;
  });

  // Set operations that feed rows into the output. Those inside expressions (IN (... UNION ...))
  // do not. Postgres 16-17 report no column origin through a set operation, so this is defense in
  // depth; tests/postgres-behavior.test.ts pins that behavior.
  walk(
    stmt,
    (n, inExpression) => {
      const s = n.SelectStmt;
      if (!inExpression && s && s.op && s.op !== "SETOP_NONE" && !mutations.has("ignore-set-operations")) facts.setOperation = true;
    },
    false,
  );

  const targets: Node[] = [];
  walk(stmt, (n) => {
    const dml = n.InsertStmt ?? n.UpdateStmt ?? n.DeleteStmt ?? n.MergeStmt;
    if (dml?.relation?.relname) targets.push(dml.relation);
  });
  for (const rv of targets) {
    const oid = await engine.relationOid(relationName(rv));
    const relation = oid === null ? null : await engine.relation(oid);
    if (mutations.has("trust-dml-targets")) continue;
    if (oid !== null && (!relation || !isTable(relation.kind) || relation.hasRules)) facts.untrustedTargets.add(oid);
  }
  return facts;
}

function mergeBySource(m: Node): boolean {
  return !!m.mergeWhenClauses?.some((c: Node) => c.MergeWhenClause?.matchKind === "MERGE_WHEN_NOT_MATCHED_BY_SOURCE");
}

async function originNotNull(field: FieldDescription, ctx: Context): Promise<boolean> {
  const facts = ctx.facts;
  if (mutations.has("trust-computed-columns") && field.tableID === 0) return true;
  if (facts.setOperation || facts.groupingSets || facts.unresolvedNullable) return false;
  if (field.tableID === 0 || field.columnID <= 0) return false;
  if (facts.nullableRelations.has(field.tableID) || facts.untrustedTargets.has(field.tableID)) return false;
  return columnNotNull(field.tableID, field.columnID, ctx.engine);
}

/**
 * Every row of the relation has a value in this column. Tables enforce NOT NULL, and a generated
 * column has a value when its expression does. A view column has one when the view's defining
 * query proves it. Materialized views (whose rows may predate a constraint) and foreign tables
 * guarantee nothing.
 */
async function columnNotNull(oid: number, attnum: number, engine: Engine): Promise<boolean> {
  const relation = await engine.relation(oid);
  if (!relation) return false;
  if (relation.kind === "v") {
    const view = await proof(engine, `view ${oid}`, async () => queryNotNull(await engine.viewDefinition(oid), engine));
    return view[attnum - 1] ?? false;
  }
  if (!isTable(relation.kind)) return false;
  if (mutations.has("ignore-not-null-constraints")) return true;
  const attribute = (await engine.attributes(oid)).find((a) => a.attnum === attnum);
  if (!attribute?.generated) return attribute?.notNull ?? false;
  if (attribute.notNull) return true;
  const sql = `SELECT (${attribute.generated}) FROM ${relation.name}`;
  return (await proof(engine, `generated ${oid}.${attnum}`, () => queryNotNull(sql, engine)))[0] ?? false;
}

/** Proves the output of a standalone query: a view's definition, or a generated column's expression. */
async function queryNotNull(sql: string, engine: Engine): Promise<boolean[]> {
  return outputNotNull(sql, (await engine.describe(sql)).fields ?? [], engine);
}

/** Proofs about the schema, kept as long as the engine that holds it. */
const proofs = new WeakMap<Engine, Map<string, Promise<boolean[]>>>();

function proof(engine: Engine, key: string, prove: () => Promise<boolean[]>): Promise<boolean[]> {
  let byKey = proofs.get(engine);
  if (!byKey) proofs.set(engine, (byKey = new Map()));
  let p = byKey.get(key);
  if (!p) byKey.set(key, (p = prove()));
  return p;
}

function isTable(relkind: string): boolean {
  return relkind === "r" || relkind === "p";
}

// ---------------------------------------------------------------------------------------------
// The FROM clause as a tree, so a column reference can be traced to the item it names and to the
// outer joins above that item.

type FromItem = RelationItem | JoinItem | OpaqueItem;

/** The outer joins above an item, from the top: each join and which side of it the item is on. */
type Path = { join: JoinItem; side: "left" | "right" }[];

interface RelationItem {
  kind: "relation";
  oid: number;
  /** The name the select list uses for it: its alias, or its table name. */
  refname: string;
  schemaname: string | undefined;
  aliased: boolean;
  path: Path;
}

interface JoinItem {
  kind: "join";
  type: string;
  left: FromItem;
  right: FromItem;
  using: string[];
  natural: boolean;
  /** `(a JOIN b ...) AS j` or `JOIN ... USING (x) AS j`: hides the inner names. */
  alias: string | undefined;
  path: Path;
}

/** A subquery, function, CTE reference or anything else whose columns sqlsure does not trace. */
interface OpaqueItem {
  kind: "opaque";
  refname: string | undefined;
  path: Path;
}

async function scopeOf(stmt: Node, facts: Facts, engine: Engine): Promise<FromItem[]> {
  const item = (n: Node, path: Path) => fromItem(n, path, facts, engine);
  if (stmt.SelectStmt) {
    const s = stmt.SelectStmt;
    if (s.op && s.op !== "SETOP_NONE") return [];
    return Promise.all((s.fromClause ?? []).map((n: Node) => item(n, [])));
  }
  const dml = stmt.InsertStmt ?? stmt.UpdateStmt ?? stmt.DeleteStmt;
  if (dml) {
    const rest: Node[] = stmt.UpdateStmt?.fromClause ?? stmt.DeleteStmt?.usingClause ?? [];
    return Promise.all([{ RangeVar: dml.relation }, ...rest].map((n) => item(n, [])));
  }
  const m = stmt.MergeStmt;
  if (m) {
    // The target joined to the source; WHEN NOT MATCHED BY SOURCE rows have no source row.
    const join: JoinItem = {
      kind: "join",
      type: mergeBySource(m) ? "JOIN_LEFT" : "JOIN_INNER",
      using: [],
      natural: false,
      alias: undefined,
      path: [],
      left: undefined!,
      right: undefined!,
    };
    join.left = await item({ RangeVar: m.relation }, [{ join, side: "left" }]);
    join.right = await item(m.sourceRelation, [{ join, side: "right" }]);
    return [join];
  }
  return [];
}

async function fromItem(n: Node, path: Path, facts: Facts, engine: Engine): Promise<FromItem> {
  if (n.RangeTableSample) return fromItem(n.RangeTableSample.relation, path, facts, engine);
  const rv = n.RangeVar;
  if (rv) {
    const refname: string = rv.alias?.aliasname ?? rv.relname;
    const opaque: OpaqueItem = { kind: "opaque", refname, path };
    // A CTE, or a table whose columns the alias renames: not traced.
    if ((!rv.schemaname && facts.cteNames.has(rv.relname)) || rv.alias?.colnames) return opaque;
    const oid = await engine.relationOid(relationName(rv));
    if (oid === null || facts.untrustedTargets.has(oid)) return opaque;
    return { kind: "relation", oid, refname, schemaname: rv.schemaname, aliased: !!rv.alias, path };
  }
  const j = n.JoinExpr;
  if (j) {
    const join: JoinItem = {
      kind: "join",
      type: j.jointype,
      using: (j.usingClause ?? []).map((s: Node) => s.String?.sval),
      natural: !!j.isNatural,
      alias: j.alias?.aliasname ?? j.join_using_alias?.aliasname,
      path,
      left: undefined!,
      right: undefined!,
    };
    join.left = await fromItem(j.larg, [...path, { join, side: "left" }], facts, engine);
    join.right = await fromItem(j.rarg, [...path, { join, side: "right" }], facts, engine);
    return join;
  }
  const inner = Object.values(n)[0] as Node | undefined;
  return { kind: "opaque", refname: inner?.alias?.aliasname, path };
}

function nullableSide(join: JoinItem, side: "left" | "right"): boolean {
  if (mutations.has("ignore-outer-joins")) return false;
  return join.type === "JOIN_FULL" || (join.type === "JOIN_LEFT" && side === "right") || (join.type === "JOIN_RIGHT" && side === "left");
}

/** Some outer join on the path, below `below` (or anywhere, when null), can NULL-extend the item. */
function nullExtended(path: Path, below: JoinItem | null): boolean {
  const start = below ? path.findIndex((s) => s.join === below) + 1 : 0;
  return path.slice(start).some((s) => nullableSide(s.join, s.side));
}

// ---------------------------------------------------------------------------------------------
// Column references.

/** What a column reference reads: a table column, or a column a USING / NATURAL join merges. */
type Value = { kind: "column"; item: RelationItem; attnum: number } | { kind: "merged"; join: JoinItem; name: string };

/** Resolves a column reference in the select list, or null when it cannot be traced. */
async function resolveColumn(ref: Node, ctx: Context): Promise<Value | null> {
  const parts: (string | undefined)[] = (ref.fields ?? []).map((f: Node) => f.String?.sval);
  if (parts.some((p) => p === undefined)) return null;
  if (parts.length === 1) {
    const found: Value[] = [];
    for (const item of ctx.scope) {
      const values = await lookup(item, parts[0]!, ctx.engine);
      if (values === "unknown") return null;
      found.push(...values);
    }
    return found.length === 1 ? found[0] : null;
  }
  if (parts.length > 3) return null;
  const [schema, rel, column] = parts.length === 3 ? parts : [undefined, ...parts];
  const items = everyItem(ctx.scope).filter((i) =>
    i.kind === "join" ? i.alias === rel : i.refname === rel && (schema === undefined || (i.kind === "relation" && !i.aliased && i.schemaname === schema)),
  );
  const item = items.length === 1 ? items[0] : undefined;
  if (item?.kind !== "relation") return null;
  const attribute = (await ctx.engine.attributes(item.oid)).find((a) => a.name === column);
  return attribute ? { kind: "column", item, attnum: attribute.attnum } : null;
}

function everyItem(items: FromItem[]): FromItem[] {
  return items.flatMap((i) => (i.kind === "join" ? [i, ...everyItem([i.left, i.right])] : [i]));
}

/** Every way an unqualified name is visible in an item; "unknown" when an untraced item may hold it. */
async function lookup(item: FromItem, name: string, engine: Engine): Promise<Value[] | "unknown"> {
  if (item.kind === "opaque") return "unknown";
  if (item.kind === "relation") {
    const attribute = (await engine.attributes(item.oid)).find((a) => a.name === name);
    return attribute ? [{ kind: "column", item, attnum: attribute.attnum }] : [];
  }
  const merged = await mergedNames(item, engine);
  if (merged === "unknown") return "unknown";
  if (merged.includes(name)) return [{ kind: "merged", join: item, name }];
  const left = await lookup(item.left, name, engine);
  const right = await lookup(item.right, name, engine);
  return left === "unknown" || right === "unknown" ? "unknown" : [...left, ...right];
}

/** The columns a join merges into one: its USING list, or the names both sides share for NATURAL. */
async function mergedNames(join: JoinItem, engine: Engine): Promise<string[] | "unknown"> {
  if (!join.natural) return join.using;
  const left = await columnNames(join.left, engine);
  const right = await columnNames(join.right, engine);
  if (left === "unknown" || right === "unknown") return "unknown";
  return left.filter((n) => right.includes(n));
}

async function columnNames(item: FromItem, engine: Engine): Promise<string[] | "unknown"> {
  if (item.kind === "opaque") return "unknown";
  if (item.kind === "relation") return (await engine.attributes(item.oid)).map((a) => a.name);
  const merged = await mergedNames(item, engine);
  const left = await columnNames(item.left, engine);
  const right = await columnNames(item.right, engine);
  if (merged === "unknown" || left === "unknown" || right === "unknown") return "unknown";
  return [...merged, ...left.filter((n) => !merged.includes(n)), ...right.filter((n) => !merged.includes(n))];
}

function sameOrigin(value: Value, field: FieldDescription): boolean {
  if (value.kind !== "column" || field.tableID === 0) return true;
  return value.item.oid === field.tableID && value.attnum === field.columnID;
}

function valueNotNull(value: Value, ctx: Context): Promise<boolean> {
  // A grouping set can NULL any grouped column.
  if (ctx.facts.groupingSets) return Promise.resolve(false);
  return valueNotNullBelow(value, null, ctx.engine);
}

/** The value is never NULL in the rows of `below` (the whole statement when null). */
async function valueNotNullBelow(value: Value, below: JoinItem | null, engine: Engine): Promise<boolean> {
  if (value.kind === "column") return !nullExtended(value.item.path, below) && columnNotNull(value.item.oid, value.attnum, engine);
  const { join, name } = value;
  if (nullExtended(join.path, below)) return false;
  // INNER and LEFT joins merge into the left column, RIGHT into the right one, FULL into
  // COALESCE(left, right), which is non-null when both are.
  const side = async (item: FromItem) => {
    const values = await lookup(item, name, engine);
    return values !== "unknown" && values.length === 1 && valueNotNullBelow(values[0], join, engine);
  };
  if (join.type === "JOIN_FULL") return (await side(join.left)) && side(join.right);
  return side(join.type === "JOIN_RIGHT" ? join.right : join.left);
}

// ---------------------------------------------------------------------------------------------
// Expressions.

/** The expression behind each output position, where it can be told. */
function alignedTargets(stmt: Node, columnCount: number): (Node | undefined)[] | null {
  let targets: Node[] | undefined;
  if (stmt.SelectStmt) {
    const s = stmt.SelectStmt;
    if (s.op && s.op !== "SETOP_NONE") return null;
    targets = s.targetList;
  } else {
    const dml = stmt.InsertStmt ?? stmt.UpdateStmt ?? stmt.DeleteStmt ?? stmt.MergeStmt;
    targets = dml?.returningClause?.exprs;
  }
  if (!targets) return null;
  const values = targets.map((t) => t.ResTarget?.val as Node | undefined);
  // `*`, `t.*` and `(composite).*` expand to any number of columns. Targets before the first one
  // line up with output columns from the start, targets after the last one from the end.
  const stars = values.flatMap((v, i) => (isStar(v) ? [i] : []));
  if (!stars.length) return values.length === columnCount ? values : null;
  const first = stars[0];
  const afterLast = values.length - stars[stars.length - 1] - 1;
  if (first + afterLast > columnCount) return null;
  const out: (Node | undefined)[] = new Array(columnCount).fill(undefined);
  for (let i = 0; i < first; i++) out[i] = values[i];
  for (let k = 1; k <= afterLast; k++) out[columnCount - k] = values[values.length - k];
  return out;
}

function isStar(e: Node | undefined): boolean {
  return !!(e?.ColumnRef?.fields?.some((f: Node) => f.A_Star) || e?.A_Indirection?.indirection?.some((f: Node) => f.A_Star));
}

/** Operators that never return NULL for non-null operands of built-in types. */
const NON_NULL_OPERATORS = new Set(["+", "-", "*", "/", "%", "^", "||", "=", "<>", "<", ">", "<=", ">="]);

const NON_NULL_WINDOW = new Set(["row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile"]);

/** Functions that never return NULL, whatever their arguments. */
const ALWAYS_NON_NULL = new Set([
  "now", "clock_timestamp", "statement_timestamp", "transaction_timestamp", "gen_random_uuid", "random",
  "concat", "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array", "merge_action",
]);

/**
 * Functions that never return NULL when no argument is NULL. Left out on purpose: substring (its
 * regex form returns NULL when nothing matches), array_length (NULL for an empty array), nullif.
 */
const NON_NULL_FOR_NON_NULL_ARGS = new Set([
  "lower", "upper", "initcap", "length", "char_length", "character_length", "octet_length", "btrim", "ltrim",
  "rtrim", "abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "mod", "md5", "replace", "repeat",
  "reverse", "left", "right", "lpad", "rpad", "substr", "split_part", "strpos", "position", "to_char",
  "date_trunc", "date_part", "extract", "cardinality", "array_to_string", "to_json", "to_jsonb", "format",
]);

async function provenNotNull(e: Node | undefined, ctx: Context): Promise<boolean> {
  if (!e || ctx.nulled(e)) return false;
  if (e.A_Const) return !e.A_Const.isnull;
  if (e.ColumnRef) {
    const value = isStar(e) ? null : await resolveColumn(e.ColumnRef, ctx);
    return !!value && valueNotNull(value, ctx);
  }
  if (e.TypeCast) return (await castKeepsValues(e.TypeCast.typeName, ctx.engine)) && provenNotNull(e.TypeCast.arg, ctx);
  if (e.NullTest || e.BooleanTest) return true;
  if (e.SubLink) return e.SubLink.subLinkType === "EXISTS_SUBLINK";
  if (e.CoalesceExpr) return someProven(e.CoalesceExpr.args, ctx);
  if (e.MinMaxExpr) return someProven(e.MinMaxExpr.args, ctx); // GREATEST/LEAST skip NULLs
  if (e.BoolExpr) return everyProven(e.BoolExpr.args, ctx);
  if (e.A_Expr) return operatorNotNull(e.A_Expr, ctx);
  if (e.FuncCall) return functionNotNull(e.FuncCall, ctx);
  if (e.SQLValueFunction) return true; // CURRENT_DATE, CURRENT_TIMESTAMP, CURRENT_USER...
  return false;
}

async function someProven(args: Node[] | undefined, ctx: Context): Promise<boolean> {
  for (const a of args ?? []) if (await provenNotNull(a, ctx)) return true;
  return false;
}

async function everyProven(args: Node[] | undefined, ctx: Context): Promise<boolean> {
  for (const a of args ?? []) if (!(await provenNotNull(a, ctx))) return false;
  return true;
}

/** The schema's own operators, functions and casts, which shadow the built-ins the rules trust. */
async function shadowing(engine: Engine): Promise<Overrides> {
  if (mutations.has("trust-shadowed-builtins")) return { operators: new Set(), functions: new Set(), castTargets: new Set() };
  return engine.overrides();
}

async function operatorNotNull(a: Node, ctx: Context): Promise<boolean> {
  const { name, overridable } = qualifiedName(a.name);
  const overridden = overridable && (await shadowing(ctx.engine)).operators.has(name);
  // IS [NOT] DISTINCT FROM is never NULL, unless a schema's own `=` returns NULL.
  if (a.kind === "AEXPR_DISTINCT" || a.kind === "AEXPR_NOT_DISTINCT") return !overridden;
  if (a.kind !== "AEXPR_OP" || !NON_NULL_OPERATORS.has(name) || overridden) return false;
  return (!a.lexpr || (await provenNotNull(a.lexpr, ctx))) && provenNotNull(a.rexpr, ctx);
}

async function functionNotNull(f: Node, ctx: Context): Promise<boolean> {
  const { name, overridable } = qualifiedName(f.funcname);
  if (overridable && (await shadowing(ctx.engine)).functions.has(name)) return false;
  if (name === "count") return true;
  if (f.over) return NON_NULL_WINDOW.has(name);
  if (ALWAYS_NON_NULL.has(name)) return true;
  if (NON_NULL_FOR_NON_NULL_ARGS.has(name) && !f.agg_star) return everyProven(f.args, ctx);
  return false;
}

/**
 * A function or operator name, lowercased. `overridable` when it is unqualified, so a schema's own
 * function of that name may be the one called. A name in another schema is never trusted.
 */
function qualifiedName(parts: Node[] | undefined): { name: string; overridable: boolean } {
  const names: string[] = (parts ?? []).map((p) => p.String?.sval ?? "");
  const name = (names[names.length - 1] ?? "").toLowerCase();
  if (names.length === 1) return { name, overridable: true };
  return names[0] === "pg_catalog" ? { name, overridable: false } : { name: "", overridable: false };
}

/** Built-in casts turn non-null values into non-null values; a cast function the schema defines may not. */
async function castKeepsValues(typeName: Node, engine: Engine): Promise<boolean> {
  const names: string[] = (typeName?.names ?? []).map((n: Node) => quote(n.String?.sval ?? ""));
  const oid = await engine.typeOid(names.join(".") + (typeName?.arrayBounds?.length ? "[]" : ""));
  if (oid === null) return false;
  const { castTargets } = await shadowing(engine);
  if (!castTargets.size) return true;
  // A cast to a domain casts to its base type; a cast to an array casts each element.
  const info = await engine.typeInfo(oid);
  return ![oid, info?.typbasetype, info?.typelem].some((t) => t && castTargets.has(t));
}

// ---------------------------------------------------------------------------------------------
// Grouping sets.

/** Expressions GROUPING SETS / ROLLUP / CUBE can set to NULL in the top-level select list. */
function groupingNulled(stmt: Node): (e: Node) => boolean {
  const s = stmt.SelectStmt;
  const keys = s?.targetList ? groupingKeys(s.groupClause ?? [], s.targetList) : new Set<string>();
  return (e) => keys.size > 0 && keys.has(normalized(e));
}

/**
 * Expressions GROUPING SETS / ROLLUP / CUBE can set to NULL in subtotal rows, normalized. Postgres
 * matches grouping expressions after resolving names, so `coalesce(a.n, 0)` is the key
 * `coalesce(n, 0)`, and an output name or a bare integer position stands for that output's
 * expression. Keys outside any grouping set are in every set and never NULLed.
 */
function groupingKeys(groupClause: Node[], targets: Node[]): Set<string> {
  const keys = new Set<string>();
  if (mutations.has("ignore-grouping-sets")) return keys;
  const add = (e: Node) => {
    keys.add(normalized(e));
    const name = e.ColumnRef?.fields?.length === 1 ? e.ColumnRef.fields[0].String?.sval : undefined;
    const position = e.A_Const?.ival ? e.A_Const.ival.ival : undefined;
    targets.forEach((t, i) => {
      if ((name !== undefined && t.ResTarget?.name === name) || position === i + 1) keys.add(normalized(t.ResTarget?.val));
    });
  };
  const visit = (n: Node, inSet: boolean) => {
    if (n.GroupingSet) for (const c of n.GroupingSet.content ?? []) visit(c, true);
    else if (inSet && n.RowExpr) for (const c of n.RowExpr.args ?? []) visit(c, true);
    else if (inSet) add(n);
  };
  for (const g of groupClause) visit(g, false);
  return keys;
}

/** A canonical form for comparing expressions: no positions, column qualifiers or casts; constants by value. */
function normalized(e: unknown): string {
  const strip = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(strip);
    if (!n || typeof n !== "object") return n;
    const o = n as Node;
    if (o.TypeCast) return strip(o.TypeCast.arg);
    if (o.ColumnRef) return { ColumnRef: strip(o.ColumnRef.fields?.[o.ColumnRef.fields.length - 1]) };
    if (o.A_Const) return { A_Const: constantText(o.A_Const) };
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "location").map(([k, v]) => [k, strip(v)]));
  };
  return JSON.stringify(strip(e));
}

/** What a constant spells, so `1` and `'1'::int` compare equal, as they do once Postgres casts them. Protobuf omits zero values. */
function constantText(c: Node): string | null {
  if (c.isnull) return null;
  if (c.ival) return String(c.ival.ival ?? 0);
  if (c.fval) return c.fval.fval;
  if (c.sval) return c.sval.sval ?? "";
  if (c.boolval) return String(c.boolval.boolval ?? false);
  if (c.bsval) return c.bsval.bsval;
  return "";
}

// ---------------------------------------------------------------------------------------------

/** Visits every node object. `inExpression` is true below a SubLink (a subquery used as a value). */
function walk(node: unknown, fn: (n: Node, inExpression: boolean) => void, inExpression = false): void {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, fn, inExpression);
    return;
  }
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  fn(n, inExpression);
  for (const [key, value] of Object.entries(n)) {
    walk(value, fn, inExpression || key === "SubLink");
  }
}

function relationName(rv: Node): string {
  return rv.schemaname ? `${quote(rv.schemaname)}.${quote(rv.relname)}` : quote(rv.relname);
}

function quote(ident: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(ident) ? ident : `"${ident.replace(/"/g, '""')}"`;
}
