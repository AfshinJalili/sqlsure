// What a .sql import is at run time: one small function per query. No query builder, no parsing
// at call time; the SQL was rewritten to `$1`, `$2` when the file was loaded.

/**
 * Anything with node-postgres' `query(config)`: a `pg` Client, Pool or PoolClient, or a driver
 * that mirrors it, such as `@neondatabase/serverless`.
 */
export interface Queryable {
  query(config: { text: string; values: unknown[]; rowMode?: "array" }): Promise<{
    rows: any[];
    fields: { name: string }[];
    rowCount?: number | null;
  }>;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** node-postgres parses `interval` into an object of the parts that are set. */
export interface Interval {
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

export interface QueryMeta {
  readonly queryName: string;
  readonly mode: "one" | "many" | "exec" | "execrows";
  /** The SQL sent to Postgres, with `$1`, `$2` placeholders. */
  readonly sql: string;
  /** Parameter names, in placeholder order. */
  readonly paramNames: readonly string[];
}

/**
 * A query function. `Query<any, any>` (an untyped query, such as one that failed analysis) accepts
 * parameters or none, so its callers do not pile errors on top of the one in the .sql file.
 */
export type Query<P, R> = (0 extends 1 & P
  ? (db: Queryable, params?: P) => Promise<R>
  : [P] extends [void]
    ? (db: Queryable) => Promise<R>
    : (db: Queryable, params: P) => Promise<R>) &
  QueryMeta;

export interface QuerySpec {
  name: string;
  mode: "one" | "many" | "exec" | "execrows";
  sql: string;
  params: string[];
}

/**
 * The keys of a result row: the column names, with a repeated name numbered the way sqlc numbers
 * it (`id`, `id_2`, `id_3`), skipping any number another column already uses. Types and run time
 * both use this one rule, so a row's keys are the keys its type declares.
 */
export function rowKeys(names: readonly string[]): string[] {
  const taken = new Set(names);
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    let n = 2;
    while (taken.has(`${name}_${n}`)) n++;
    taken.add(`${name}_${n}`);
    return `${name}_${n}`;
  });
}

export function defineQuery(spec: QuerySpec): Query<any, any> {
  const { name, mode, sql, params } = spec;
  const run = async (db: Queryable, args?: Record<string, unknown>) => {
    const values = params.map((p) => {
      if (!args || !(p in args)) throw new TypeError(`sqlsure: ${name} is missing parameter "${p}".`);
      return args[p];
    });
    if (mode === "exec" || mode === "execrows") {
      const result = await db.query({ text: sql, values });
      return mode === "execrows" ? (result.rowCount ?? 0) : undefined;
    }
    // Rows arrive as arrays and get their keys here, so two columns with the same name both survive.
    const result = await db.query({ text: sql, values, rowMode: "array" });
    const keys = rowKeys(result.fields.map((f) => f.name));
    const toRow = (values: unknown[]) => {
      const row: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) row[keys[i]] = values[i];
      return row;
    };
    if (mode === "one") return result.rows.length ? toRow(result.rows[0]) : null;
    return result.rows.map(toRow);
  };
  Object.defineProperty(run, "name", { value: name });
  return Object.assign(run, { queryName: name, mode, sql, paramNames: params }) as unknown as Query<any, any>;
}
