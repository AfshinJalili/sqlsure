// Performance: what sqlsure adds to `tsc`, and what it adds to each query at run time.
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tsc } from "./tsc.ts";
import { defineQuery } from "../../src/runtime.ts";
import { freshDatabase, dropDatabase } from "./pg.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const RUNTIME_TRIALS = 9;

export interface TscTiming {
  queries: number;
  files: number;
  warmMs: number;
  /** First run on a machine: no cached Postgres data directory. */
  coldMs: number;
  baselineMs: number;
  perQueryMs: number;
}

export interface PerfResult {
  tsc: TscTiming[];
  runtime: { calls: number; trials: number; rawMsPerCall: number; sqlsureMsPerCall: number; overheadUsPerCall: number };
}

const TEMPLATES = [
  "SELECT id, email, display_name, created_at FROM users WHERE id = :id",
  "SELECT p.id, p.name, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.price > :min",
  "SELECT o.id, o.status, sum(oi.quantity * oi.unit_price) AS total FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.user_id = :userId GROUP BY o.id, o.status",
  "INSERT INTO reviews (product_id, user_id, stars, body) VALUES (:productId, :userId?, :stars, :body?) RETURNING id",
  "UPDATE users SET last_login = now() WHERE id = :id",
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function makeProject(dir: string, queries: number): number {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "schema.sql"), readFileSync(join(ROOT, "evals/suites/shop/schema.sql")));
  const perFile = 10;
  const files = Math.max(1, Math.ceil(queries / perFile));
  const imports: string[] = [];
  let q = 0;
  for (let f = 0; f < files; f++) {
    const blocks: string[] = [];
    for (let i = 0; i < perFile && q < queries; i++, q++) {
      const sql = TEMPLATES[q % TEMPLATES.length];
      const mode = sql.startsWith("UPDATE") ? "exec" : sql.startsWith("INSERT") ? "one" : "many";
      blocks.push(`-- name: q${q} :${mode}\n${sql};`);
    }
    writeFileSync(join(dir, `f${f}.sql`), blocks.join("\n\n") + "\n");
    imports.push(`import * as f${f} from "./f${f}.sql";`);
  }
  writeFileSync(join(dir, "main.ts"), `${imports.join("\n")}\nvoid [${Array.from({ length: files }, (_, i) => `f${i}`).join(", ")}];\n`);
  writeFileSync(join(dir, "baseline.ts"), "export const x = 1;\n");
  const config = (include: string) =>
    JSON.stringify({
      compilerOptions: { target: "es2023", module: "nodenext", strict: true, noEmit: true, skipLibCheck: true, types: [] },
      contentMappers: [{ package: "sqlsure", extensions: [".sql"], options: { schema: "./schema.sql" } }],
      include: [include],
    });
  writeFileSync(join(dir, "tsconfig.json"), config("main.ts"));
  writeFileSync(join(dir, "tsconfig.baseline.json"), config("baseline.ts"));
  return files;
}

export async function runPerf(opts: { sizes: number[]; log?: (s: string) => void }): Promise<PerfResult> {
  const timings: TscTiming[] = [];
  for (const n of opts.sizes) {
    const dir = join(ROOT, `evals/.cache/perf/q${n}`);
    const files = makeProject(dir, n);
    const coldCache = mkdtempSync(join(tmpdir(), "sqlsure-cold-"));
    const cold = tsc(join(dir, "tsconfig.json"), [], { SQLSURE_CACHE_DIR: coldCache });
    rmSync(coldCache, { recursive: true, force: true });
    if (!cold.ok) throw new Error(`perf project q${n} failed to type-check:\n${cold.output.slice(0, 2000)}`);
    const warm: number[] = [];
    const base: number[] = [];
    for (let i = 0; i < 3; i++) {
      warm.push(tsc(join(dir, "tsconfig.json")).ms);
      base.push(tsc(join(dir, "tsconfig.baseline.json")).ms);
    }
    const warmMs = median(warm);
    const baselineMs = median(base);
    timings.push({ queries: n, files, warmMs, coldMs: cold.ms, baselineMs, perQueryMs: (warmMs - baselineMs) / n });
    opts.log?.(`  perf: ${n} queries, warm ${warmMs.toFixed(0)} ms, cold ${cold.ms.toFixed(0)} ms, baseline tsc ${baselineMs.toFixed(0)} ms`);
  }

  // Run-time overhead against the real driver.
  const db = await freshDatabase("perf");
  const calls = 3000;
  const getOne = defineQuery({ name: "getOne", mode: "one", sql: "SELECT $1::int AS x", params: ["x"] });
  const raw: number[] = [];
  const ours: number[] = [];
  const viaPg = (i: number) => db.query("SELECT $1::int AS x", [i]).then((r) => r.rows[0]);
  const viaSqlsure = (i: number) => getOne(db, { x: i });
  const batch = async (call: (i: number) => Promise<unknown>) => {
    const t = performance.now();
    for (let i = 0; i < calls; i++) await call(i);
    return performance.now() - t;
  };
  try {
    for (let i = 0; i < 300; i++) await viaPg(i), await viaSqlsure(i); // warm up both paths
    for (let trial = 0; trial < RUNTIME_TRIALS; trial++) {
      // Alternate which runs first, so a machine slowing down mid-trial is not counted as overhead.
      if (trial % 2) ours.push(await batch(viaSqlsure)), raw.push(await batch(viaPg));
      else raw.push(await batch(viaPg)), ours.push(await batch(viaSqlsure));
    }
  } finally {
    await dropDatabase(db);
  }
  const rawMs = median(raw) / calls;
  const oursMs = median(ours) / calls;
  const overheadMs = median(ours.map((o, i) => o - raw[i])) / calls;
  return {
    tsc: timings,
    runtime: { calls, trials: RUNTIME_TRIALS, rawMsPerCall: rawMs, sqlsureMsPerCall: oursMs, overheadUsPerCall: overheadMs * 1000 },
  };
}
