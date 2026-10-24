import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFile } from "../src/parse-file.ts";
import { compileSqlModule } from "../src/register.ts";
import { defineQuery } from "../src/runtime.ts";

test("named queries, modes and docs", () => {
  const f = parseFile(`-- leading comment is fine
-- name: getUser :one
-- Fetch a user.
SELECT * FROM users WHERE id = :id;

/* name: listUsers :many */
SELECT * FROM users;
`);
  assert.deepEqual(f.problems, []);
  assert.deepEqual(
    f.queries.map((q) => [q.name, q.mode, q.doc, q.sql]),
    [
      ["getUser", "one", ["Fetch a user."], "SELECT * FROM users WHERE id = $1"],
      ["listUsers", "many", [], "SELECT * FROM users"],
    ],
  );
});

test("parameters: reuse, nullable, and everything that is not a parameter", () => {
  const [q] = parseFile(`-- name: q :many
SELECT a::text, ':nope', "col:x", $tag$ :nope $tag$, arr[1:2], E'\\':nope'
FROM t WHERE a = :a AND b = :b? AND c = :a -- :nope
/* :nope */`).queries;
  assert.equal(q.sql.includes(":nope"), true);
  assert.deepEqual(q.params, [
    { name: "a", nullable: false },
    { name: "b", nullable: true },
  ]);
  assert.match(q.sql, /WHERE a = \$1 AND b = \$2 AND c = \$1/);
});

test("offsets map back to the original file", () => {
  const source = `-- name: q :one\nSELECT x FROM t WHERE id = :someLongName AND bogus = 1`;
  const [q] = parseFile(source).queries;
  const at = q.sql.indexOf("bogus");
  assert.equal(source.slice(q.toOriginal(at), q.toOriginal(at) + 5), "bogus");
});

test("problems", () => {
  const cases: [string, RegExp][] = [
    ["SELECT 1;", /No named queries/],
    ["SELECT 1;\n-- name: q :one\nSELECT 1", /outside a named query/],
    ["-- name: q\nSELECT 1", /Expected `-- name/],
    ["-- name: q :all\nSELECT 1", /Unknown mode/],
    ["-- name: q :one\nSELECT 1;\n-- name: q :one\nSELECT 2", /Duplicate/],
    ["-- name: q :one\nSELECT $1", /Positional/],
    ["-- name: q :exec\nDELETE FROM a; DELETE FROM b", /One statement/],
    ["-- name: q :one\n", /no SQL/],
    ["-- name: delete :exec\nDELETE FROM a", /reserved word/],
  ];
  for (const [source, message] of cases) {
    const f = parseFile(source);
    assert.ok(f.problems.some((p) => message.test(p.message)), `${JSON.stringify(source)} -> ${JSON.stringify(f.problems)}`);
  }
});

test("semicolons inside strings do not split statements", () => {
  const f = parseFile(`-- name: q :one\nSELECT ';' AS a, $$;$$ AS b;`);
  assert.deepEqual(f.problems, []);
});

test("runtime module", () => {
  const js = compileSqlModule("-- name: getUser :one\nSELECT 1 WHERE 1 = :id;\n", "/x/users.sql");
  assert.match(js, /export const getUser = defineQuery\(/);
  assert.throws(() => compileSqlModule("SELECT 1", "/x/bad.sql"), /bad\.sql:1/);
});

test("query functions", async () => {
  const calls: [string, unknown[] | undefined][] = [];
  const db = {
    async query(text: string, values?: unknown[]) {
      calls.push([text, values]);
      return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
    },
  };
  const one = defineQuery({ name: "one", mode: "one", sql: "S $1 $2", params: ["a", "b"] });
  const many = defineQuery({ name: "many", mode: "many", sql: "S", params: [] });
  const rows = defineQuery({ name: "rows", mode: "execrows", sql: "D", params: [] });
  const exec = defineQuery({ name: "exec", mode: "exec", sql: "U", params: [] });
  assert.deepEqual(await one(db, { b: 2, a: 1 }), { id: 1 });
  assert.deepEqual(calls[0], ["S $1 $2", [1, 2]]);
  assert.equal((await many(db)).length, 2);
  assert.equal(await rows(db), 2);
  assert.equal(await exec(db), undefined);
  await assert.rejects(() => one(db, { a: 1 }), /missing parameter "b"/);
  assert.equal(one.sql, "S $1 $2");
  assert.deepEqual(one.paramNames, ["a", "b"]);
});
