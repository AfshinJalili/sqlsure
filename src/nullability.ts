// Decides which output columns can never be NULL. The rule is conservative by design: a column is
// non-null only when we can prove it, and every doubt makes it nullable. The eval harness measures
// both directions against a real Postgres: a wrong "non-null" is a soundness failure, a needless
// "nullable" costs precision.
import { loadModule, parseSync } from "libpg-query";
import type { Engine, FieldDescription } from "./engine.ts";

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
  const facts = await analyzeStatement(sql, engine, fields.length);
  const out: boolean[] = [];
  for (let i = 0; i < fields.length; i++) out.push(await fieldNotNull(fields[i], i, facts, engine));
  return out;
}

interface Facts {
  /** Relations (OIDs) that appear on the nullable side of an outer join anywhere in the statement. */
  nullableRelations: Set<number>;
  /** A relation on a nullable side could not be resolved, so no column origin can be trusted. */
  unresolvedNullable: boolean;
  /** GROUPING SETS / ROLLUP / CUBE: grouped columns become NULL in subtotal rows. */
  groupingSets: boolean;
  /** A UNION/INTERSECT/EXCEPT feeds the output (top level, FROM, or a CTE). */
  setOperation: boolean;
  /** Per output position: proven non-null by its expression, or undefined when it cannot be told. */
  expressionNotNull: (boolean | undefined)[] | null;
  /**
   * DML targets whose RETURNING is not bound by the table's constraints: views (an INSTEAD OF
   * trigger returns what it likes) and relations with rewrite rules.
   */
  untrustedTargets: Set<number>;
}

/** `columnCount` is how many columns Postgres described, to check the select list lines up with them. */
async function analyzeStatement(sql: string, engine: Engine, columnCount: number): Promise<Facts> {
  await ready();
  const tree = parseSync(sql) as Node;
  const stmt: Node = tree.stmts?.[0]?.stmt ?? {};

  const ctes = new Map<string, Node>();
  walk(stmt, (n) => {
    const cte = n.CommonTableExpr;
    if (cte?.ctename && cte.ctequery) ctes.set(cte.ctename, cte.ctequery);
  });

  const facts: Facts = {
    nullableRelations: new Set(),
    unresolvedNullable: false,
    groupingSets: false,
    setOperation: false,
    expressionNotNull: null,
    untrustedTargets: new Set(),
  };

  // Outer joins, and MERGE ... WHEN NOT MATCHED BY SOURCE, which returns target rows that have no
  // source row.
  const nullableSides: Node[] = [];
  walk(stmt, (n) => {
    const m = n.MergeStmt;
    if (m?.mergeWhenClauses?.some((c: Node) => c.MergeWhenClause?.matchKind === "MERGE_WHEN_NOT_MATCHED_BY_SOURCE"))
      nullableSides.push(m.sourceRelation);
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
    if (oid !== null && (!relation || !isTable(relation.kind) || relation.hasRules)) facts.untrustedTargets.add(oid);
  }

  facts.expressionNotNull = expressionFacts(stmt, columnCount);
  return facts;
}

function expressionFacts(stmt: Node, columnCount: number): (boolean | undefined)[] | null {
  let targets: Node[] | undefined;
  let keys = new Set<string>();
  if (stmt.SelectStmt) {
    const s = stmt.SelectStmt;
    if (s.op && s.op !== "SETOP_NONE") return null;
    targets = s.targetList;
    if (targets) keys = groupingKeys(s.groupClause ?? [], targets);
  } else {
    const dml = stmt.InsertStmt ?? stmt.UpdateStmt ?? stmt.DeleteStmt ?? stmt.MergeStmt;
    targets = dml?.returningClause?.exprs;
  }
  if (!targets) return null;
  // `*`, `t.*` and `(composite).*` expand to any number of columns. Targets before the first one
  // line up with output columns from the start, targets after the last one from the end.
  const stars = targets.flatMap((t, i) => (isStar(t.ResTarget?.val) ? [i] : []));
  const nulled = (e: Node) => keys.size > 0 && keys.has(normalized(e));
  const proven = (t: Node) => (provenNotNull(t.ResTarget?.val, nulled) ? true : undefined);
  if (!stars.length) return targets.length === columnCount ? targets.map(proven) : null;
  const first = stars[0];
  const afterLast = targets.length - stars[stars.length - 1] - 1;
  if (first + afterLast > columnCount) return null;
  const out: (boolean | undefined)[] = new Array(columnCount).fill(undefined);
  for (let i = 0; i < first; i++) out[i] = proven(targets[i]);
  for (let k = 1; k <= afterLast; k++) out[columnCount - k] = proven(targets[targets.length - k]);
  return out;
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

function isStar(e: Node | undefined): boolean {
  return !!(e?.ColumnRef?.fields?.some((f: Node) => f.A_Star) || e?.A_Indirection?.indirection?.some((f: Node) => f.A_Star));
}

const NON_NULL_WINDOW = new Set(["row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile"]);

/** `nulled` marks expressions a grouping set can set to NULL, whatever they are made of. */
function provenNotNull(e: Node | undefined, nulled: (e: Node) => boolean): boolean {
  if (!e || nulled(e)) return false;
  if (e.A_Const) return !e.A_Const.isnull;
  if (e.TypeCast) return provenNotNull(e.TypeCast.arg, nulled);
  if (e.NullTest) return true;
  if (e.BooleanTest) return true;
  if (e.SubLink) return e.SubLink.subLinkType === "EXISTS_SUBLINK";
  if (e.CoalesceExpr) return (e.CoalesceExpr.args ?? []).some((a: Node) => provenNotNull(a, nulled));
  if (e.FuncCall) {
    const name = funcName(e.FuncCall);
    if (name === "count") return true;
    if (e.FuncCall.over && NON_NULL_WINDOW.has(name)) return true;
    if (name === "now" || name === "gen_random_uuid" || name === "current_timestamp") return true;
    return false;
  }
  if (e.SQLValueFunction) return true; // CURRENT_DATE, CURRENT_TIMESTAMP, CURRENT_USER...
  return false;
}

function funcName(f: Node): string {
  const parts: Node[] = f.funcname ?? [];
  const last = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[0]?.String?.sval : undefined;
  if (schema && schema !== "pg_catalog") return "";
  return (last?.String?.sval ?? "").toLowerCase();
}

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

/** Combines the catalog with the facts above. */
async function fieldNotNull(
  field: FieldDescription,
  position: number,
  facts: Facts,
  engine: Engine,
): Promise<boolean> {
  const expr = facts.expressionNotNull?.[position];
  if (expr) return true;
  if (mutations.has("trust-computed-columns") && field.tableID === 0) return true;
  if (mutations.has("ignore-not-null-constraints") && field.tableID !== 0 && !facts.nullableRelations.has(field.tableID)) return true;
  if (facts.setOperation || facts.groupingSets || facts.unresolvedNullable) return false;
  if (field.tableID === 0 || field.columnID <= 0) return false;
  if (facts.nullableRelations.has(field.tableID) || facts.untrustedTargets.has(field.tableID)) return false;
  return columnNotNull(field.tableID, field.columnID, engine);
}

/** Every row of the relation has a value in this column. Only tables enforce NOT NULL; views and foreign tables do not. */
async function columnNotNull(oid: number, attnum: number, engine: Engine): Promise<boolean> {
  const relation = await engine.relation(oid);
  if (!relation || !isTable(relation.kind)) return false;
  return (await engine.attributes(oid)).some((a) => a.attnum === attnum && a.notNull);
}

function isTable(relkind: string): boolean {
  return relkind === "r" || relkind === "p";
}
