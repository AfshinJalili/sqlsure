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

export interface Facts {
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
}

export async function analyzeStatement(sql: string, engine: Engine): Promise<Facts> {
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
  };

  // Outer joins.
  const nullableSides: Node[] = [];
  walk(stmt, (n) => {
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
        if (!visitedCtes.has(rv.relname)) {
          visitedCtes.add(rv.relname);
          collect(ctes.get(rv.relname)!);
        }
        return;
      }
      names.add(rv.schemaname ? `${quote(rv.schemaname)}.${quote(rv.relname)}` : quote(rv.relname));
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
  // do not.
  walk(
    stmt,
    (n, inExpression) => {
      const s = n.SelectStmt;
      if (!inExpression && s && s.op && s.op !== "SETOP_NONE" && !mutations.has("ignore-set-operations")) facts.setOperation = true;
    },
    false,
  );

  facts.expressionNotNull = expressionFacts(stmt);
  return facts;
}

function expressionFacts(stmt: Node): (boolean | undefined)[] | null {
  let targets: Node[] | undefined;
  if (stmt.SelectStmt) {
    const s = stmt.SelectStmt;
    if (s.op && s.op !== "SETOP_NONE") return null;
    targets = s.targetList;
  } else {
    const dml = stmt.InsertStmt ?? stmt.UpdateStmt ?? stmt.DeleteStmt ?? stmt.MergeStmt;
    targets = dml?.returningList;
  }
  if (!targets) return null;
  // `*` expands to an unknown number of columns, so positions no longer line up.
  let star = false;
  walkShallowTargets(targets, (n) => {
    if (n.ColumnRef?.fields?.some((f: Node) => f.A_Star)) star = true;
  });
  if (star) return null;
  return targets.map((t) => (provenNotNull(t.ResTarget?.val) ? true : undefined));
}

const NON_NULL_WINDOW = new Set(["row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile"]);

function provenNotNull(e: Node | undefined): boolean {
  if (!e) return false;
  if (e.A_Const) return !e.A_Const.isnull;
  if (e.TypeCast) return provenNotNull(e.TypeCast.arg);
  if (e.NullTest) return true;
  if (e.BooleanTest) return true;
  if (e.SubLink) return e.SubLink.subLinkType === "EXISTS_SUBLINK";
  if (e.CoalesceExpr) return (e.CoalesceExpr.args ?? []).some(provenNotNull);
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

function walkShallowTargets(targets: Node[], fn: (n: Node) => void) {
  for (const t of targets) {
    const v = t.ResTarget?.val;
    if (v) fn(v);
  }
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

function quote(ident: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(ident) ? ident : `"${ident.replace(/"/g, '""')}"`;
}

/** Combines the catalog with the facts above. */
export async function fieldNotNull(
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
  if (facts.nullableRelations.has(field.tableID)) return false;
  return engine.isNotNull(field.tableID, field.columnID);
}
