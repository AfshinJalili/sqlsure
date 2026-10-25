// Soundness and precision for one suite: sqlsure types every query, then real Postgres runs every
// query (on an empty database, then on randomly seeded ones) and every returned value is checked
// against the type sqlsure claimed. Hand-written ground-truth labels measure precision.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { Engine, extensionsIn } from "../../src/engine.ts";
import { analyzeFile, type QueryInfo } from "../../src/analyze.ts";
import { conforms, render } from "../../src/pgtypes.ts";
import { defineQuery } from "../../src/runtime.ts";
import { freshDatabase, dropDatabase, preparedTypes } from "./pg.ts";
import { rng, seed } from "./seed.ts";

export interface Violation {
  suite: string;
  query: string;
  column: string;
  kind: "null-in-nonnull" | "wrong-type" | "missing-column" | "extra-column" | "type-oid-mismatch" | "label-unsound";
  detail: string;
}

export interface SuiteResult {
  suite: string;
  queries: number;
  analyzed: number;
  analysisProblems: string[];
  executedQueries: number;
  runs: number;
  erroredRuns: number;
  rowsChecked: number;
  valuesChecked: number;
  violations: Violation[];
  labeled: { nonnull: number; nonnullInferredNonnull: number; nullable: number; nullableInferredNullable: number };
  precisionMisses: string[];
  /** Columns inferred non-null, of all columns. */
  inferredNonnull: number;
  columns: number;
}

type Labels = Record<string, Record<string, "nonnull" | "nullable">>;

export interface SuiteInput {
  name: string;
  schema: string;
  queries: { file: string; text: string }[];
  labels?: Labels;
  /** Run each query with this many random parameter sets per database state. */
  runsPerQuery?: number;
  seeds?: number[];
  rowsPerTable?: number;
}

export function loadSuiteDir(dir: string, name: string): SuiteInput {
  const queriesFile = join(dir, "queries.sql");
  const labelsFile = join(dir, "expect.json");
  return {
    name,
    schema: readFileSync(join(dir, "schema.sql"), "utf8"),
    queries: [{ file: queriesFile, text: readFileSync(queriesFile, "utf8") }],
    labels: existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, "utf8")) : undefined,
  };
}

export async function runSuite(input: SuiteInput): Promise<SuiteResult> {
  const result: SuiteResult = {
    suite: input.name,
    queries: 0,
    analyzed: 0,
    analysisProblems: [],
    executedQueries: 0,
    runs: 0,
    erroredRuns: 0,
    rowsChecked: 0,
    valuesChecked: 0,
    violations: [],
    labeled: { nonnull: 0, nonnullInferredNonnull: 0, nullable: 0, nullableInferredNullable: 0 },
    precisionMisses: [],
    inferredNonnull: 0,
    columns: 0,
  };

  const engine = await Engine.create(extensionsIn(input.schema));
  try {
    await engine.loadSchema(input.schema);
  } catch (e) {
    await engine.close();
    result.analysisProblems.push(`schema failed in sqlsure: ${(e as Error).message}`);
    return result;
  }
  const infos: QueryInfo[] = [];
  const typeNames = new Map<QueryInfo, string[]>();
  for (const q of input.queries) {
    const a = await analyzeFile(q.text, engine);
    result.queries += a.queries.length + a.failed.length;
    result.analyzed += a.queries.length;
    for (const p of a.problems) result.analysisProblems.push(`${q.file}: ${p.message}`);
    infos.push(...a.queries);
    for (const info of a.queries) typeNames.set(info, await engine.typeNames(info.columns.map((c) => c.oid)));
  }
  await engine.close();

  // Static checks against hand labels.
  for (const info of infos) {
    for (const col of info.columns) {
      result.columns++;
      if (!col.nullable) result.inferredNonnull++;
      const label = input.labels?.[info.name]?.[col.name];
      if (!label) continue;
      if (label === "nonnull") {
        result.labeled.nonnull++;
        if (!col.nullable) result.labeled.nonnullInferredNonnull++;
        else result.precisionMisses.push(`${input.name}.${info.name}.${col.name}`);
      } else {
        result.labeled.nullable++;
        if (col.nullable) result.labeled.nullableInferredNullable++;
        else
          result.violations.push({
            suite: input.name,
            query: info.name,
            column: col.name,
            kind: "label-unsound",
            detail: "labeled nullable, inferred non-null",
          });
      }
    }
  }

  const db = await freshDatabase(input.name);
  try {
    try {
      await db.query(input.schema);
    } catch (e) {
      result.analysisProblems.push(`schema failed on real Postgres: ${(e as Error).message}`);
      return result;
    }
    await crossCheckTypes(db, infos, typeNames, result);

    const executed = new Set<string>();
    const states = [{ label: "empty" }, ...(input.seeds ?? [1, 2]).map((s) => ({ label: `seed ${s}`, seed: s }))];
    for (const state of states) {
      if ("seed" in state && state.seed !== undefined) {
        await db.query(`do $$ declare r record; begin
          for r in select format('%I.%I', schemaname, tablename) t from pg_tables
            where schemaname not in ('pg_catalog','information_schema') loop
            execute 'truncate ' || r.t || ' cascade'; end loop; end $$`);
        await seed(db, { seed: state.seed, rowsPerTable: input.rowsPerTable ?? 30 });
      }
      const pools = await valuePools(db);
      const r = rng(("seed" in state ? state.seed : 0)! + 1000);
      for (const info of infos) {
        // Run it the way users do: through the query function sqlsure generates for it.
        const run = defineQuery({ name: info.name, mode: "many", sql: capRows(info.sql), params: info.params.map((p) => p.name) });
        const runs = info.params.length ? (input.runsPerQuery ?? 12) : 1;
        for (let i = 0; i < runs; i++) {
          const values = info.params.map((p) => pickParam(p.oid, p.nullable, pools, r));
          result.runs++;
          let rows: any[];
          try {
            await db.query("begin");
            // A runaway query (an endless recursive CTE, a giant generate_series) must not hang or
            // exhaust the harness: cap its time, and cap rows for plain reads.
            await db.query("set local statement_timeout = '3s'");
            rows = await run(db, Object.fromEntries(info.params.map((p, i) => [p.name, values[i]])));
          } catch {
            result.erroredRuns++;
            await db.query("rollback").catch(() => {});
            continue;
          }
          await db.query("rollback").catch(() => {});
          executed.add(info.name);
          checkRows(input.name, info, rows, result);
        }
      }
    }
    result.executedQueries = executed.size;
  } finally {
    await dropDatabase(db);
  }
  return result;
}

function checkRows(suite: string, info: QueryInfo, rows: any[], result: SuiteResult): void {
  if (!info.columns.length) return;
  const seen = new Set<string>();
  for (const row of rows) {
    result.rowsChecked++;
    const keys = Object.keys(row);
    for (const k of keys) {
      if (!info.columns.some((c) => c.name === k)) addOnce(result, seen, { suite, query: info.name, column: k, kind: "extra-column", detail: "returned but not typed" });
    }
    for (const col of info.columns) {
      if (!(col.name in row)) {
        addOnce(result, seen, { suite, query: info.name, column: col.name, kind: "missing-column", detail: "typed but not returned" });
        continue;
      }
      const v = row[col.name];
      result.valuesChecked++;
      if (v === null) {
        // JSON's own `null` is part of the Json type even in a NOT NULL column.
        if (!col.nullable && col.type.kind !== "json")
          addOnce(result, seen, { suite, query: info.name, column: col.name, kind: "null-in-nonnull", detail: `typed ${render(col.type)}, got NULL` });
        continue;
      }
      if (!conforms(col.type, v))
        addOnce(result, seen, {
          suite,
          query: info.name,
          column: col.name,
          kind: "wrong-type",
          detail: `typed ${render(col.type)}, got ${describe(v)}`,
        });
    }
  }
}

function addOnce(result: SuiteResult, seen: Set<string>, v: Violation) {
  const key = `${v.query}.${v.column}.${v.kind}`;
  if (seen.has(key) || result.violations.some((x) => `${x.query}.${x.column}.${x.kind}` === key && x.suite === v.suite)) return;
  seen.add(key);
  result.violations.push(v);
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return `array ${JSON.stringify(v).slice(0, 60)}`;
  if (v instanceof Date) return "Date";
  if (Buffer.isBuffer(v)) return "Buffer";
  return `${typeof v} ${JSON.stringify(v)?.slice(0, 60)}`;
}

/**
 * Real Postgres' PREPARE must agree with the types PGlite reported, compared by name since the two
 * servers number user types differently. On the wire a domain is sent as its base type, so the
 * real side is normalized the same way.
 */
async function crossCheckTypes(db: pg.Client, infos: QueryInfo[], typeNames: Map<QueryInfo, string[]>, result: SuiteResult): Promise<void> {
  for (const info of infos) {
    if (!info.columns.length) continue;
    let real;
    try {
      real = await preparedTypes(db, info.sql);
    } catch (e) {
      result.analysisProblems.push(`${info.name}: real Postgres rejected the statement: ${(e as Error).message}`);
      continue;
    }
    const names = typeNames.get(info) ?? [];
    const based = await db.query(
      `select array(select (case when t.typtype = 'd' then t.typbasetype else t.oid end)::regtype::text
         from unnest($1::regtype[]) with ordinality u(r, i) join pg_type t on t.oid = u.r order by u.i) as names`,
      [real.results ?? []],
    );
    const theirs: string[] = based.rows[0].names;
    if (theirs.length !== names.length) {
      result.violations.push({ suite: result.suite, query: info.name, column: "*", kind: "type-oid-mismatch", detail: `columns ${names.length} vs ${theirs.length}` });
      continue;
    }
    names.forEach((n, i) => {
      if (n !== theirs[i])
        result.violations.push({ suite: result.suite, query: info.name, column: info.columns[i].name, kind: "type-oid-mismatch", detail: `sqlsure ${n}, Postgres ${theirs[i]}` });
    });
  }
}

/** Wraps a read in a LIMIT. Writes and statements with data-modifying CTEs run as written. */
function capRows(sql: string): string {
  const head = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^(select|with|values|table)\b/i.test(head)) return sql;
  if (/\b(insert|update|delete|merge)\b/i.test(sql)) return sql;
  return `SELECT * FROM (\n${sql}\n) AS sqlsure_capped LIMIT 2000`;
}

type Pools = Map<number, string[]>;

async function valuePools(db: pg.Client): Promise<Pools> {
  const cols = await db.query(`
    select format('%I.%I', n.nspname, c.relname) as t, a.attname as col, a.atttypid::int as oid,
           coalesce(nullif(ty.typbasetype, 0), a.atttypid)::int as base
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_type ty on ty.oid = a.atttypid
    where c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
      and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'`);
  const pools: Pools = new Map();
  for (const c of cols.rows) {
    const r = await db.query(`select distinct "${c.col.replace(/"/g, '""')}"::text as v from ${c.t} where "${c.col.replace(/"/g, '""')}" is not null limit 12`);
    for (const oid of new Set([c.oid, c.base])) {
      const list = pools.get(oid) ?? [];
      list.push(...r.rows.map((x) => x.v));
      pools.set(oid, list);
    }
  }
  return pools;
}

const FALLBACK: Record<number, string[]> = {
  16: ["true", "false"],
  20: ["1", "0", "42"],
  21: ["1", "2"],
  23: ["1", "2", "3", "0", "-1"],
  25: ["a", "", "x"],
  1043: ["a", "x"],
  1700: ["1.5", "0"],
  700: ["1.5"],
  701: ["2.5"],
  1082: ["2026-01-01"],
  1114: ["2026-01-01 00:00:00"],
  1184: ["2026-01-01 00:00:00+00"],
  2950: ["00000000-0000-4000-a000-000000000000"],
  3802: ['{"a":1}'],
  114: ['{"a":1}'],
};

function pickParam(oid: number, nullable: boolean, pools: Pools, r: () => number): string | null {
  if (nullable && r() < 0.3) return null;
  const pool = pools.get(oid)?.length ? pools.get(oid)! : (FALLBACK[oid] ?? ["1"]);
  return pool[Math.floor(r() * pool.length)];
}
