// Fills every table with random rows that are designed to break wrong types: NULL in every column
// that allows it, JSON `null` literals, arrays holding NULL, parents with no children, extreme
// numbers. Deterministic for a given seed, so a failure can be replayed.
import type pg from "pg";

interface ColumnInfo {
  name: string;
  type: string; // format_type
  typtype: string;
  typcategory: string;
  elemType: string | null;
  notnull: boolean;
  hasDefault: boolean;
  generated: boolean;
  identity: boolean;
  enumLabels: string[] | null;
}

interface TableInfo {
  oid: number;
  qualified: string;
  columns: ColumnInfo[];
  fks: { columns: string[]; refTable: number; refColumns: string[] }[];
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

async function introspect(db: pg.Client): Promise<TableInfo[]> {
  const tables = await db.query(`
    select c.oid::int as oid, format('%I.%I', n.nspname, c.relname) as qualified
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and not c.relispartition
      and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
    order by 1`);
  const out: TableInfo[] = [];
  for (const t of tables.rows) {
    const cols = await db.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, ty.typtype::text as typtype,
              ty.typcategory::text as typcategory,
              case when ty.typelem <> 0 then format_type(ty.typelem, null) end as "elemType",
              a.attnotnull as notnull, a.atthasdef as "hasDefault", a.attgenerated <> '' as generated,
              a.attidentity <> '' as identity,
              (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
                 where e.enumtypid = coalesce(nullif(ty.typelem, 0), a.atttypid)) as "enumLabels"
       from pg_attribute a join pg_type ty on ty.oid = a.atttypid
       where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [t.oid],
    );
    const fks = await db.query(
      `select (select array_agg(attname::text order by k.ord) from unnest(con.conkey) with ordinality k(n, ord)
                 join pg_attribute on attrelid = con.conrelid and attnum = k.n) as columns,
              con.confrelid::int as "refTable",
              (select array_agg(attname::text order by k.ord) from unnest(con.confkey) with ordinality k(n, ord)
                 join pg_attribute on attrelid = con.confrelid and attnum = k.n) as "refColumns"
       from pg_constraint con where con.conrelid = $1 and con.contype = 'f'`,
      [t.oid],
    );
    out.push({ oid: t.oid, qualified: t.qualified, columns: cols.rows, fks: fks.rows });
  }
  return out;
}

function order(tables: TableInfo[]): TableInfo[] {
  const done = new Set<number>();
  const result: TableInfo[] = [];
  const visit = (t: TableInfo, stack: Set<number>) => {
    if (done.has(t.oid) || stack.has(t.oid)) return;
    stack.add(t.oid);
    for (const fk of t.fks) {
      const ref = tables.find((x) => x.oid === fk.refTable);
      if (ref && ref !== t) visit(ref, stack);
    }
    done.add(t.oid);
    result.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return result;
}

function randomScalar(type: string, category: string, labels: string[] | null, r: () => number): string | null {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  if (labels?.length) return pick(labels);
  const t = type.toLowerCase();
  if (/^(smallint)/.test(t)) return String(Math.floor(r() * 30000) - 100);
  if (/^(integer|int)/.test(t)) return String(pick([0, 1, 2, 3, 42, -7, 2147483647, Math.floor(r() * 1000)]));
  if (/^bigint/.test(t)) return pick(["0", "1", "9007199254740993", "-5", String(Math.floor(r() * 1e6))]);
  if (/^(numeric|decimal)/.test(t)) return pick(["0", "1.5", "-3.25", "12345678901234567890.123", "1"]);
  if (/^(real|double)/.test(t)) return pick(["0", "1.5", "-2.75", "3.14159", "1e10"]);
  if (/^boolean/.test(t)) return pick(["true", "false"]);
  if (/^(text|character varying|varchar|character|char|name|citext)/.test(t))
    return pick(["", "a", "hello world", "ünïcödé", "x".repeat(8), `s${Math.floor(r() * 1e6)}`]).slice(0, maxLen(t));
  if (/^uuid/.test(t)) return uuid(r);
  if (/^jsonb?/.test(t)) return pick(['{"a":1}', "null", "[1,null,\"x\"]", '"str"', "3", "{}", '{"nested":{"b":[true]}}']);
  if (/^timestamp/.test(t)) return pick(["2026-01-01 12:00:00+00", "1999-12-31 23:59:59+00", "2030-06-15 08:30:00+00"]);
  if (/^date/.test(t)) return pick(["2026-01-01", "1999-12-31", "2030-06-15"]);
  if (/^time/.test(t)) return pick(["12:00:00", "00:00:01", "23:59:59"]);
  if (/^interval/.test(t)) return pick(["1 day", "2 hours 3 minutes", "1 year 2 months", "00:00:01"]);
  if (/^bytea/.test(t)) return pick(["\\x00", "\\xdeadbeef", "\\x"]);
  if (/^inet/.test(t)) return pick(["127.0.0.1", "10.0.0.0/8", "::1"]);
  if (/^cidr/.test(t)) return pick(["10.0.0.0/8", "192.168.0.0/16"]);
  if (/^macaddr/.test(t)) return "08:00:2b:01:02:03";
  if (/^point/.test(t)) return pick(["(1,2)", "(0,0)", "(-1.5,3)"]);
  if (/^money/.test(t)) return "12.34";
  if (category === "S") return `s${Math.floor(r() * 1e6)}`;
  return null;
}

function maxLen(t: string): number {
  const m = /\((\d+)\)/.exec(t);
  return m ? Number(m[1]) : 1000;
}

function uuid(r: () => number): string {
  const h = () => Math.floor(r() * 16).toString(16);
  const s = Array.from({ length: 32 }, h).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

function randomValue(c: ColumnInfo, r: () => number): string | null | undefined {
  if (c.typcategory === "A") {
    const el = c.elemType ?? "text";
    const n = Math.floor(r() * 4);
    const items: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = r() < 0.25 ? null : randomScalar(el, "", c.enumLabels, r);
      items.push(v === null ? "NULL" : `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    }
    return `{${items.join(",")}}`;
  }
  const v = randomScalar(c.type, c.typcategory, c.enumLabels, r);
  return v === null ? undefined : v;
}

export interface SeedReport {
  rowsInserted: number;
  attempts: number;
  perTable: Record<string, number>;
}

export async function seed(db: pg.Client, opts: { seed: number; rowsPerTable: number }): Promise<SeedReport> {
  const r = rng(opts.seed);
  const tables = order(await introspect(db));
  const report: SeedReport = { rowsInserted: 0, attempts: 0, perTable: {} };
  await db.query("begin");
  try {
    await seedTables(db, tables, r, opts, report);
    await db.query("commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
  return report;
}

async function seedTables(
  db: pg.Client,
  tables: TableInfo[],
  r: () => number,
  opts: { rowsPerTable: number },
  report: SeedReport,
): Promise<void> {
  for (const t of tables) {
    let inserted = 0;
    // First an attempt with NULL in every column that allows it.
    for (let attempt = 0; attempt < opts.rowsPerTable * 4 && inserted < opts.rowsPerTable; attempt++) {
      report.attempts++;
      const allNull = attempt === 0;
      const cols: string[] = [];
      const vals: (string | null)[] = [];
      const casts: string[] = [];
      let impossible = false;
      for (const c of t.columns) {
        if (c.generated) continue;
        const fk = t.fks.find((f) => f.columns.includes(c.name));
        if (fk) continue; // filled below
        if (c.identity) continue;
        if (!c.notnull && (allNull || r() < 0.3)) {
          cols.push(c.name);
          vals.push(null);
          casts.push(c.type);
          continue;
        }
        if (c.hasDefault && r() < 0.6) continue;
        const v = randomValue(c, r);
        if (v === undefined) {
          if (c.hasDefault) continue;
          if (c.notnull) {
            impossible = true;
            break;
          }
          cols.push(c.name);
          vals.push(null);
          casts.push(c.type);
          continue;
        }
        cols.push(c.name);
        vals.push(v);
        casts.push(c.type);
      }
      if (impossible) break;
      // Foreign keys: copy a random existing referenced row, or NULL where allowed.
      let fkFailed = false;
      for (const fk of t.fks) {
        const nullable = fk.columns.every((name) => !t.columns.find((c) => c.name === name)?.notnull);
        if (nullable && (allNull || r() < 0.3)) {
          for (const name of fk.columns) {
            cols.push(name);
            vals.push(null);
            casts.push(t.columns.find((c) => c.name === name)!.type);
          }
          continue;
        }
        const ref = tables.find((x) => x.oid === fk.refTable);
        if (!ref) {
          fkFailed = true;
          break;
        }
        const row = await db
          .query(
            `select ${fk.refColumns.map((c) => `${ident(c)}::text`).join(", ")} from ${ref.qualified} order by random() limit 1`,
          )
          .catch(() => ({ rows: [] as any[] }));
        if (!row.rows.length) {
          if (nullable) {
            for (const name of fk.columns) {
              cols.push(name);
              vals.push(null);
              casts.push(t.columns.find((c) => c.name === name)!.type);
            }
            continue;
          }
          fkFailed = true;
          break;
        }
        fk.columns.forEach((name, i) => {
          cols.push(name);
          vals.push(row.rows[0][fk.refColumns[i]] ?? Object.values(row.rows[0])[i]);
          casts.push(t.columns.find((c) => c.name === name)!.type);
        });
      }
      if (fkFailed) break;
      const sql = cols.length
        ? `insert into ${t.qualified} (${cols.map(ident).join(", ")}) values (${vals.map((_, i) => `$${i + 1}::${casts[i]}`).join(", ")})`
        : `insert into ${t.qualified} default values`;
      try {
        await db.query("savepoint s");
        await db.query(sql, vals);
        await db.query("release savepoint s");
        inserted++;
      } catch {
        await db.query("rollback to savepoint s").catch(() => {});
      }
    }
    report.perTable[t.qualified] = inserted;
    report.rowsInserted += inserted;
  }
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
