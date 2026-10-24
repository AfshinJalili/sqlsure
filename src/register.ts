// `node --import sqlsure/register app.ts`: makes `import { getUser } from "./users.sql"` work at run
// time. Needs no schema and no database: it only splits the file and rewrites parameters.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFile } from "./parse-file.ts";
import { emitRuntime } from "./emit.ts";

export function compileSqlModule(source: string, path: string): string {
  const parsed = parseFile(source);
  if (parsed.problems.length) {
    const p = parsed.problems[0];
    const line = source.slice(0, p.start).split("\n").length;
    throw new SyntaxError(`sqlsure: ${path}:${line}: ${p.message}`);
  }
  return emitRuntime(parsed);
}

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const clean = url.replace(/[?#].*$/, "");
    if (!clean.endsWith(".sql") || clean !== url) return nextLoad(url, context);
    const path = fileURLToPath(clean);
    return { format: "module", source: compileSqlModule(readFileSync(path, "utf8"), path), shortCircuit: true };
  },
});
