// The Vite and esbuild plugins turn a .sql file into the same module sqlsure/register loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSqlModule } from "../src/emit.ts";
import vite from "../src/vite.ts";
import esbuild from "../src/esbuild.ts";

const SQL = "-- name: getUser :one\nSELECT 1 WHERE 1 = :id;\n";

test("the Vite plugin compiles .sql modules and leaves ?raw, virtual and other modules alone", () => {
  const plugin = vite();
  assert.deepEqual(plugin.transform(SQL, "/x/users.sql"), { code: compileSqlModule(SQL, "/x/users.sql"), map: null });
  assert.equal(plugin.transform(SQL, "/x/users.sql?raw"), null);
  assert.equal(plugin.transform(SQL, "\0virtual.sql"), null);
  assert.equal(plugin.transform("export {}", "/x/a.ts"), null);
  assert.throws(() => plugin.transform("SELECT 1", "/x/bad.sql"), /bad\.sql:1/);
});

test("the esbuild plugin loads .sql files as JavaScript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlsure-esbuild-"));
  try {
    const path = join(dir, "users.sql");
    writeFileSync(path, SQL);
    let filter: RegExp | undefined;
    let load: ((args: { path: string }) => Promise<{ contents: string; loader: "js" }>) | undefined;
    esbuild().setup({ onLoad: (options, callback) => ((filter = options.filter), (load = callback)) });
    assert.ok(filter?.test(path) && !filter.test(join(dir, "a.ts")));
    assert.deepEqual(await load!({ path }), { contents: compileSqlModule(SQL, path), loader: "js" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
