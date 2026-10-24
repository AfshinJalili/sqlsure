// What a .sql import is at run time: one small function per query. No query builder, no parsing
// at call time; the SQL was rewritten to `$1`, `$2` when the file was loaded.

/** Anything with node-postgres' `query(text, values)`: a `pg` Client, Pool or PoolClient. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
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

export type Query<P, R> = ([P] extends [void]
  ? (db: Queryable) => Promise<R>
  : (db: Queryable, params: P) => Promise<R>) &
  QueryMeta;

export interface QuerySpec {
  name: string;
  mode: "one" | "many" | "exec" | "execrows";
  sql: string;
  params: string[];
}

export function defineQuery(spec: QuerySpec): Query<any, any> {
  const { name, mode, sql, params } = spec;
  const run = async (db: Queryable, args?: Record<string, unknown>) => {
    const values = params.map((p) => {
      if (!args || !(p in args)) throw new TypeError(`sqlsure: ${name} is missing parameter "${p}".`);
      return args[p];
    });
    const result = await db.query(sql, values);
    switch (mode) {
      case "one":
        return result.rows[0] ?? null;
      case "many":
        return result.rows;
      case "execrows":
        return result.rowCount ?? 0;
      default:
        return undefined;
    }
  };
  Object.defineProperty(run, "name", { value: name });
  return Object.assign(run, { queryName: name, mode, sql, paramNames: params }) as unknown as Query<any, any>;
}
