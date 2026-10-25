// `npm run smoke`: installs the packed tarball into a copy of examples/basic, the way a user would,
// and checks the promises the README makes: tsc types .sql imports, a schema change fails tsc at
// the exact line in the .sql file, Vitest loads .sql files through `sqlsure/vite`, and the queries
// run through `sqlsure/register` under Node and `sqlsure/bun` under Bun.
//
// Needs Bun on PATH. Runs the run-time steps against SQLSURE_EVAL_PG (see evals/lib/pg.ts).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropDatabase, freshDatabase } from "./lib/pg.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "sqlsure-smoke-"));
const app = join(work, "app");

function run(cmd: string, args: string[], env: Record<string, string> = {}): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function check(name: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "✅" : "❌"} ${name}`);
  if (!passed) throw new Error(`smoke check failed: ${name}\n${detail}`);
}

try {
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop()!;
  cpSync(join(ROOT, "examples/basic"), app, { recursive: true });
  const pkgPath = join(app, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies.sqlsure = `file:${join(work, tarball)}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const install = run("npm", ["install", "--no-audit", "--no-fund"]);
  check(`npm install ${tarball} into a fresh copy of examples/basic`, install.ok, install.output);

  const typed = run("npx", ["tsc", "-p", ".", "--noEmit", "--runExternalCode"]);
  check("tsc --runExternalCode types the .sql imports", typed.ok, typed.output);

  const schemaPath = join(app, "db/schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, schema.replace("  display_name text,\n", ""));
  const broken = run("npx", ["tsc", "-p", ".", "--noEmit", "--runExternalCode"]);
  writeFileSync(schemaPath, schema);
  check(
    "dropping a column fails tsc at src/users.sql:2:19",
    !broken.ok && broken.output.includes("src/users.sql(2,19)") && broken.output.includes('column "display_name" does not exist'),
    broken.output,
  );

  const tested = run("npx", ["vitest", "run"]);
  check("vitest loads .sql files through sqlsure/vite", tested.ok && /1 passed/.test(tested.output), tested.output);

  const db = await freshDatabase("smoke");
  try {
    await db.query(schema);
    const url = new URL(process.env.SQLSURE_EVAL_PG ?? "postgres://postgres@127.0.0.1:54329/postgres");
    url.pathname = `/${db.database}`;
    const ranQueries = (output: string) => /demo\+\d+@example\.com/.test(output) && output.includes("deleted in a rolled-back transaction: 1");
    const started = run("node", ["--import", "sqlsure/register", "src/main.ts"], { DATABASE_URL: url.toString() });
    check("node --import sqlsure/register runs the queries", started.ok && ranQueries(started.output), started.output);
    const bun = run("bun", ["--preload", "sqlsure/bun", "src/main.ts"], { DATABASE_URL: url.toString() });
    check("bun --preload sqlsure/bun runs the queries", bun.ok && ranQueries(bun.output), bun.output);
  } finally {
    await dropDatabase(db);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
