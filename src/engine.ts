// A private Postgres (PGlite, Postgres compiled to WebAssembly) that holds the user's schema.
// Nothing is executed against it except the schema itself and catalog lookups: queries are only
// parsed and described, which is how Postgres reports parameter and column types.
import { PGlite } from "@electric-sql/pglite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FieldDescription {
  name: string;
  /** OID of the table the column comes from, or 0 when it is computed. */
  tableID: number;
  /** Attribute number in that table, or 0. */
  columnID: number;
  dataTypeID: number;
}

export interface Description {
  params: number[];
  /** null when the statement returns no rows (`noData`). */
  fields: FieldDescription[] | null;
}

export class PostgresError extends Error {
  /** 1-based character position in the statement, as Postgres reports it. */
  position: number | undefined;
  code: string | undefined;
  constructor(message: string, position: number | undefined, code: string | undefined) {
    super(message);
    this.position = position;
    this.code = code;
  }
}

const enc = new TextEncoder();
function message(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, body.length + 4);
  out.set(body, 5);
  return out;
}
function cstring(s: string): Uint8Array {
  const b = enc.encode(s);
  const o = new Uint8Array(b.length + 1);
  o.set(b);
  return o;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    o.set(p, i);
    i += p.length;
  }
  return o;
}

export interface TypeInfo {
  oid: number;
  /** 'b' base, 'e' enum, 'd' domain, 'c' composite, 'r' range, 'm' multirange, 'p' pseudo */
  typtype: string;
  typcategory: string;
  typelem: number;
  typbasetype: number;
}

export interface Relation {
  oid: number;
  /** pg_class.relkind: 'r' table, 'p' partitioned table, 'v' view, 'm' materialized view, 'f' foreign table... */
  kind: string;
  /** The name to reach it by from the schema's search_path, quoted where needed. */
  name: string;
  /** Rewrite rules, including a view's own; a DO INSTEAD rule can make RETURNING return anything. */
  hasRules: boolean;
}

/**
 * Names the schema defines outside pg_catalog. A query naming one of these may call the schema's
 * own operator, function or cast instead of the built-in one.
 */
export interface Overrides {
  operators: Set<string>;
  functions: Set<string>;
  /** Types that some cast function outside pg_catalog converts to. */
  castTargets: Set<number>;
}

export interface Attribute {
  attnum: number;
  name: string;
  /** The column is declared NOT NULL. Only tables enforce it. */
  notNull: boolean;
}

export class Engine {
  private db: PGlite;
  private queue: Promise<unknown> = Promise.resolve();
  private relationCache = new Map<number, Promise<Relation | null>>();
  private attributeCache = new Map<number, Promise<Attribute[]>>();
  private types = new Map<number, TypeInfo | null>();
  private typeNameCache = new Map<string, Promise<number | null>>();
  private overrideCache: Promise<Overrides> | undefined;
  private relations = new Map<string, number | null>();
  enums = new Map<number, string[]>();

  private constructor(db: PGlite) {
    this.db = db;
  }

  /**
   * A fresh Postgres. The first boot runs initdb (~2-3 s); its data directory is kept, in memory
   * and in a disk cache, so later boots, including later tsc runs, start from it (~0.3 s).
   */
  static async create(extensionNames: string[] = []): Promise<Engine> {
    const extensions = await loadExtensions(extensionNames);
    const template = await templateDataDir();
    const db = new PGlite({ extensions, ...(template ? { loadDataDir: template } : {}) });
    await db.waitReady;
    return new Engine(db);
  }

  /** Serializes access: PGlite runs one protocol exchange at a time. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async loadSchema(sql: string): Promise<void> {
    await this.lock(async () => {
      try {
        await this.db.exec(sql);
      } catch (e) {
        throw toPostgresError(e);
      }
    });
    await this.loadEnums();
  }

  private async loadEnums(): Promise<void> {
    const r = await this.lock(() =>
      this.db.query<{ oid: number; labels: string[] }>(
        "select enumtypid::int as oid, array_agg(enumlabel::text order by enumsortorder) as labels from pg_enum group by enumtypid",
      ),
    );
    this.enums = new Map(r.rows.map((row) => [row.oid, row.labels]));
  }

  describe(sql: string): Promise<Description> {
    return this.lock(async () => {
      const parse = message("P", concat(cstring(""), cstring(sql), new Uint8Array([0, 0])));
      const describe = message("D", concat(new Uint8Array([83]), cstring("")));
      const sync = message("S", new Uint8Array());
      let result;
      try {
        result = await this.db.execProtocol(concat(parse, describe, sync));
      } catch (e) {
        throw toPostgresError(e);
      }
      let params: number[] = [];
      let fields: FieldDescription[] | null = null;
      for (const m of result.messages as unknown as Array<Record<string, any>>) {
        if (m.name === "parameterDescription") params = [...m.dataTypeIDs];
        else if (m.name === "rowDescription")
          fields = m.fields.map((f: any) => ({ name: f.name, tableID: f.tableID, columnID: f.columnID, dataTypeID: f.dataTypeID }));
        else if (m.name === "error") throw toPostgresError(m);
      }
      return { params, fields };
    });
  }

  relation(oid: number): Promise<Relation | null> {
    let cached = this.relationCache.get(oid);
    if (!cached) {
      cached = this.lock(() =>
        this.db.query<Relation>(
          'select oid::int as oid, relkind::text as kind, oid::regclass::text as name, relhasrules as "hasRules" from pg_class where oid = $1',
          [oid],
        ),
      ).then((r) => r.rows[0] ?? null);
      this.relationCache.set(oid, cached);
    }
    return cached;
  }

  /** The relation's user columns, in order. */
  attributes(oid: number): Promise<Attribute[]> {
    let cached = this.attributeCache.get(oid);
    if (!cached) {
      cached = this.lock(() =>
        this.db.query<Attribute>(
          "select attnum::int as attnum, attname::text as name, attnotnull as \"notNull\" from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped order by attnum",
          [oid],
        ),
      ).then((r) => r.rows);
      this.attributeCache.set(oid, cached);
    }
    return cached;
  }

  /** Resolves a relation name the way the query would, or null. */
  async relationOid(qualified: string): Promise<number | null> {
    const cached = this.relations.get(qualified);
    if (cached !== undefined) return cached;
    const r = await this.lock(() =>
      this.db.query<{ oid: number | null }>("select to_regclass($1)::oid::int as oid", [qualified]),
    );
    const oid = r.rows[0]?.oid ?? null;
    this.relations.set(qualified, oid);
    return oid;
  }

  /** Resolves a type name (`int4`, `pg_catalog.varchar`, `"My".t[]`) the way a cast would, or null. */
  typeOid(name: string): Promise<number | null> {
    let cached = this.typeNameCache.get(name);
    if (!cached) {
      cached = this.lock(() => this.db.query<{ oid: number | null }>("select to_regtype($1)::oid::int as oid", [name])).then(
        (r) => r.rows[0]?.oid ?? null,
      );
      this.typeNameCache.set(name, cached);
    }
    return cached;
  }

  overrides(): Promise<Overrides> {
    return (this.overrideCache ??= this.lock(() =>
      this.db.query<{ operators: string[]; functions: string[]; casts: number[] }>(
        `select
           array(select distinct oprname::text from pg_operator where oprnamespace <> 'pg_catalog'::regnamespace) as operators,
           array(select distinct proname::text from pg_proc where pronamespace <> 'pg_catalog'::regnamespace) as functions,
           array(select distinct c.casttarget::int from pg_cast c join pg_proc p on p.oid = c.castfunc
                 where p.pronamespace <> 'pg_catalog'::regnamespace) as casts`,
      ),
    ).then((r) => ({ operators: new Set(r.rows[0].operators), functions: new Set(r.rows[0].functions), castTargets: new Set(r.rows[0].casts) })));
  }

  async typeInfo(oid: number): Promise<TypeInfo | null> {
    const cached = this.types.get(oid);
    if (cached !== undefined) return cached;
    const r = await this.lock(() =>
      this.db.query<TypeInfo>(
        "select oid::int as oid, typtype::text as typtype, typcategory::text as typcategory, typelem::int as typelem, typbasetype::int as typbasetype from pg_type where oid = $1",
        [oid],
      ),
    );
    const info = r.rows[0] ?? null;
    this.types.set(oid, info);
    return info;
  }

  async typeNames(oids: number[]): Promise<string[]> {
    const r = await this.lock(() =>
      this.db.query<{ names: string[] }>("select array(select unnest($1::oid[])::regtype::text) as names", [oids]),
    );
    return r.rows[0].names;
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

let template: Promise<Blob | undefined> | undefined;

function cacheFile(): string {
  const base = process.env.SQLSURE_CACHE_DIR ?? join(tmpdir(), "sqlsure-cache");
  return join(base, `pglite-${PGLITE_VERSION}-template.tar`);
}

const require = createRequire(import.meta.url);
const PGLITE_VERSION: string = (() => {
  try {
    const main = require.resolve("@electric-sql/pglite");
    return JSON.parse(readFileSync(join(dirname(main), "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

function templateDataDir(): Promise<Blob | undefined> {
  return (template ??= (async () => {
    const file = cacheFile();
    try {
      if (existsSync(file)) return new Blob([readFileSync(file)]);
    } catch {}
    try {
      const db = new PGlite();
      await db.waitReady;
      const dump = await db.dumpDataDir("none");
      await db.close();
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}`;
        writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
        renameSync(tmp, file);
      } catch {}
      return dump;
    } catch {
      return undefined;
    }
  })());
}

/** Postgres contrib extensions PGlite ships, loaded when the schema creates them. */
const CONTRIB = new Set([
  "amcheck", "bloom", "btree_gin", "btree_gist", "citext", "cube", "dict_int", "dict_xsyn", "earthdistance",
  "fuzzystrmatch", "hstore", "intarray", "isn", "lo", "ltree", "moddatetime", "pg_trgm", "pgcrypto", "seg",
  "tablefunc", "tcn", "tsm_system_rows", "tsm_system_time", "unaccent", "uuid_ossp",
]);

export function extensionsIn(schemaSql: string): string[] {
  const names = new Set<string>();
  for (const m of schemaSql.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z0-9_-]+)"?/gi))
    names.add(m[1].toLowerCase().replace(/-/g, "_"));
  return [...names].filter((n) => CONTRIB.has(n)).sort();
}

async function loadExtensions(names: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const name of names) {
    if (!CONTRIB.has(name)) continue;
    const mod = await import(`@electric-sql/pglite/contrib/${name}`);
    out[name] = mod[name];
  }
  return out;
}

function toPostgresError(e: unknown): PostgresError {
  if (e instanceof PostgresError) return e;
  const err = e as { message?: string; position?: string | number; code?: string };
  const pos = err.position === undefined ? undefined : Number(err.position);
  return new PostgresError(err.message ?? String(e), Number.isFinite(pos) ? pos : undefined, err.code);
}
