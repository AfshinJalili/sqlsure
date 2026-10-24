// Breadth: sqlc's end-to-end test suite (MIT, github.com/sqlc-dev/sqlc), a corpus of real-world
// Postgres queries that sqlsure's author did not write. sqlc's own syntax is translated to
// sqlsure's (`sqlc.arg(x)`/`@x` -> `:x`, `$1` -> `:p1`) and the translation is counted.
//
// Each query is judged against real Postgres: if real Postgres accepts it and sqlsure cannot type
// it, that is a breadth failure. Every query sqlsure types is then executed on randomly seeded
// data and every value checked, as in the suites.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { Engine, extensionsIn } from "../../src/engine.ts";
import { analyzeFile } from "../../src/analyze.ts";
import { parseFile } from "../../src/parse-file.ts";
import { upSection } from "../../src/schema.ts";
import { freshDatabase, dropDatabase, preparedTypes } from "./pg.ts";
import { runSuite, type SuiteResult } from "./suite.ts";

export const SQLC_COMMIT = "3ad8b20fb02b5bea81591b673da0758b8685d951";

export interface CorpusResult {
  source: string;
  commit: string;
  casesFound: number;
  casesDeduplicated: number;
  casesExpectedToFail: number;
  casesSchemaInvalidOnPostgres: number;
  casesSchemaFailedInSqlsure: string[];
  queries: number;
  translated: number;
  unsupportedSyntax: { reason: string; count: number }[];
  rejectedByPostgres: number;
  acceptedByPostgres: number;
  typed: number;
  failures: { case: string; query: string; reason: string }[];
  /** Real Postgres rejected but sqlsure typed: sqlsure is laxer than the server (PGlite is a newer Postgres). */
  sqlsureLaxer: number;
  dynamic: SuiteResult[];
}

export function ensureCorpus(cacheDir: string): string {
  const dir = join(cacheDir, "sqlc");
  const testdata = join(dir, "internal/endtoend/testdata");
  if (!existsSync(testdata)) {
    execFileSync("git", ["clone", "--filter=blob:none", "--sparse", "--no-checkout", "https://github.com/sqlc-dev/sqlc.git", dir], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "sparse-checkout", "set", "internal/endtoend/testdata"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "checkout", SQLC_COMMIT], { stdio: "ignore" });
  }
  return testdata;
}

interface Case {
  id: string;
  schema: string;
  queries: string;
}

/** Schema files are joined as statements; query files as plain text, since blocks end on their own. */
function readPaths(base: string, spec: string | string[], separator: string): string {
  const list = Array.isArray(spec) ? spec : [spec];
  const texts: string[] = [];
  for (const p of list) {
    const full = join(base, p);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full).sort()) if (f.endsWith(".sql")) texts.push(upSection(readFileSync(join(full, f), "utf8")));
    } else texts.push(upSection(readFileSync(full, "utf8")));
  }
  return texts.join(separator);
}

function configEntries(file: string): { schema: string | string[]; queries: string | string[]; engine: string }[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    const j = JSON.parse(text);
    return (j.packages ?? j.sql ?? []).map((p: any) => ({ schema: p.schema, queries: p.queries, engine: p.engine }));
  }
  // Minimal YAML: sqlc configs are flat lists of `- schema: x` / `queries: y` / `engine: z`.
  const out: { schema: string | string[]; queries: string | string[]; engine: string }[] = [];
  let cur: any = null;
  for (const line of text.split("\n")) {
    const m = /^\s*(-\s+)?(schema|queries|engine)\s*:\s*"?([^"#\n]*)"?\s*$/.exec(line);
    if (!m) continue;
    if (m[1] || !cur || cur[m[2]] !== undefined) {
      cur = {};
      out.push(cur);
    }
    cur[m[2]] = m[3].trim();
  }
  return out.filter((e) => e.schema && e.queries);
}

function findCases(testdata: string, stats: CorpusResult): Case[] {
  const configs: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^sqlc\.(json|ya?ml)$/.test(name)) configs.push(p);
    }
  };
  visit(testdata);
  const seen = new Set<string>();
  const cases: Case[] = [];
  for (const cfg of configs.sort()) {
    const dir = dirname(cfg);
    let entries;
    try {
      entries = configEntries(cfg);
    } catch {
      continue;
    }
    for (const [i, e] of entries.entries()) {
      if (e.engine !== "postgresql") continue;
      stats.casesFound++;
      if (existsSync(join(dir, "stderr.txt")) || readdirSync(dir).some((f) => f.startsWith("stderr"))) {
        stats.casesExpectedToFail++;
        continue;
      }
      const schema = readPaths(dir, e.schema, "\n;\n");
      const queries = readPaths(dir, e.queries, "\n\n");
      if (!queries.trim()) continue;
      const hash = createHash("sha256").update(schema).update("\0").update(queries).digest("hex");
      if (seen.has(hash)) {
        stats.casesDeduplicated++;
        continue;
      }
      seen.add(hash);
      cases.push({ id: `${relative(testdata, dir)}${entries.length > 1 ? `#${i}` : ""}`, schema, queries });
    }
  }
  return cases;
}

const MODE_MAP: Record<string, string | null> = {
  one: "one",
  many: "many",
  exec: "exec",
  execrows: "execrows",
  execresult: "exec",
  batchone: "one",
  batchmany: "many",
  batchexec: "exec",
  copyfrom: null,
  execlastid: null,
};

/** sqlc syntax -> sqlsure syntax, per query block. Returns null with a reason when untranslatable. */
export function translate(block: string): { text: string; changed: boolean } | { unsupported: string } {
  let changed = false;
  const header = /^--\s*name:\s*(\S+)\s+:(\w+)/m.exec(block) ?? /^\/\*\s*name:\s*(\S+)\s+:(\w+)\s*\*\//m.exec(block);
  if (!header) return { unsupported: "no sqlc header" };
  const mode = MODE_MAP[header[2].toLowerCase()];
  if (mode === undefined) return { unsupported: `sqlc mode :${header[2]}` };
  if (mode === null) return { unsupported: `sqlc mode :${header[2]}` };
  let text = block.replace(header[0], `-- name: ${header[1]} :${mode}`);
  if (mode !== header[2]) changed = true;
  if (/sqlc\.(slice|embed)\s*\(/i.test(text)) return { unsupported: "sqlc.slice / sqlc.embed macros" };
  const before = text;
  text = text.replace(/sqlc\.narg\s*\(\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*\)/gi, ":$1?");
  text = text.replace(/sqlc\.arg\s*\(\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\s*\)/gi, ":$1");
  text = text.replace(/(^|[^A-Za-z0-9_@>?<&|\-#])@([A-Za-z_][A-Za-z0-9_]*)/g, "$1:$2");
  text = text.replace(/(^|[^A-Za-z0-9_$])\$(\d+)\b/g, "$1:p$2");
  if (text !== before) changed = true;
  return { text, changed };
}

function splitBlocks(queries: string): string[] {
  const parts = queries.split(/(?=^(?:--|\/\*)\s*name:)/m);
  return parts.filter((p) => /^(?:--|\/\*)\s*name:/m.test(p));
}

export async function runCorpus(cacheDir: string, opts: { dynamic: boolean; limit?: number; concurrency?: number; log?: (s: string) => void }): Promise<CorpusResult> {
  const testdata = ensureCorpus(cacheDir);
  const stats: CorpusResult = {
    source: "sqlc-dev/sqlc internal/endtoend/testdata",
    commit: SQLC_COMMIT,
    casesFound: 0,
    casesDeduplicated: 0,
    casesExpectedToFail: 0,
    casesSchemaInvalidOnPostgres: 0,
    casesSchemaFailedInSqlsure: [],
    queries: 0,
    translated: 0,
    unsupportedSyntax: [],
    rejectedByPostgres: 0,
    acceptedByPostgres: 0,
    typed: 0,
    failures: [],
    sqlsureLaxer: 0,
    dynamic: [],
  };
  const unsupported = new Map<string, number>();
  let cases = findCases(testdata, stats);
  if (opts.limit) cases = cases.slice(0, opts.limit);
  let done = 0;
  const processCase = async (c: Case, n: number) => {
    const db = await freshDatabase(`corpus_${n}`);
    try {
      try {
        await db.query(c.schema);
      } catch {
        stats.casesSchemaInvalidOnPostgres++;
        return;
      }
      const engine = await Engine.create(extensionsIn(c.schema));
      try {
        try {
          await engine.loadSchema(c.schema);
        } catch (e) {
          stats.casesSchemaFailedInSqlsure.push(`${c.id}: ${(e as Error).message}`);
          for (const b of splitBlocks(c.queries)) {
            stats.queries++;
            stats.failures.push({ case: c.id, query: /name:\s*(\S+)/.exec(b)?.[1] ?? "?", reason: "schema did not load in sqlsure" });
          }
          return;
        }
        const translatedBlocks: string[] = [];
        for (const block of splitBlocks(c.queries)) {
          stats.queries++;
          const t = translate(block);
          if ("unsupported" in t) {
            unsupported.set(t.unsupported, (unsupported.get(t.unsupported) ?? 0) + 1);
            continue;
          }
          if (t.changed) stats.translated++;
          const parsed = parseFile(t.text);
          const q = parsed.queries[0];
          const name = /name:\s*(\S+)/.exec(t.text)?.[1] ?? "?";
          if (!q) {
            stats.failures.push({ case: c.id, query: name, reason: `parse: ${parsed.problems[0]?.message}` });
            continue;
          }
          let realOk = true;
          try {
            await preparedTypes(db, q.sql);
          } catch {
            realOk = false;
          }
          const a = await analyzeFile(t.text, engine);
          const ok = a.queries.length === 1 && a.problems.length === 0;
          if (!realOk) {
            stats.rejectedByPostgres++;
            if (ok) stats.sqlsureLaxer++;
            continue;
          }
          stats.acceptedByPostgres++;
          if (ok) {
            stats.typed++;
            translatedBlocks.push(t.text);
          } else stats.failures.push({ case: c.id, query: name, reason: a.problems[0]?.message ?? "not typed" });
        }
        if (opts.dynamic && translatedBlocks.length) {
          await dropDatabase(db);
          const r = await runSuite({
            name: `corpus_${n}_dyn`,
            schema: c.schema,
            queries: [{ file: c.id, text: translatedBlocks.join("\n\n") }],
            runsPerQuery: 4,
            seeds: [1],
            rowsPerTable: 12,
          });
          r.suite = c.id;
          for (const v of r.violations) v.suite = c.id;
          stats.dynamic.push(r);
        }
      } finally {
        await engine.close();
      }
    } finally {
      await dropDatabase(db);
      done++;
      if (done % 50 === 0) opts.log?.(`  corpus ${done}/${cases.length}`);
    }
  };
  const queue = cases.map((c, i) => [c, i + 1] as const);
  const workers = Array.from({ length: opts.concurrency ?? 4 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await processCase(next[0], next[1]);
  });
  await Promise.all(workers);
  stats.failures.sort((a, b) => (a.case + a.query < b.case + b.query ? -1 : 1));
  stats.dynamic.sort((a, b) => (a.suite < b.suite ? -1 : 1));
  stats.unsupportedSyntax = [...unsupported].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return stats;
}
